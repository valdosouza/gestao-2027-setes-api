import { CellValue, XlsxSheet, excelSerialToIsoDate } from '@shared/xlsx/read-xlsx'

/**
 * Peça @shared/ibscbs-catalog — LEITURA E VALIDAÇÃO das fontes oficiais do catálogo
 * IBS/CBS (fase IBS/CBS, IB-1 — prompt_fase_ibs_cbs.md §10.5):
 *   - D-IB23: a tabela oficial "IT 2025.002 vX - cClassTrib.xlsx" é a fonte de
 *     identidade, vigência (dIniVig/dFimVig), ind_gTribRegular e aplicabilidade por
 *     documento (indNFSe/indNFe/indNFCe); a API da Calculadora só CONFERE (reconcile.ts).
 *   - Anexo VII da NFS-e (cIndOp) e a lista de NBS da Calculadora.
 * Tudo é validado ANTES de gravar ("o que valida é o que grava" — o banco do dev roda
 * sem modo estrito e truncaria em silêncio). Estrutura oficial mudada = erro ALTO.
 * Funções PURAS (sem banco) — testáveis com planilhas fabricadas.
 */

export class CatalogSourceError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(problems.length ? `${message}:\n  - ${problems.slice(0, 30).join('\n  - ')}${problems.length > 30 ? `\n  … +${problems.length - 30}` : ''}` : message)
  }
}

export interface CstRecord { id: string; description: string }

export interface ClassificationRecord {
  code:                    string
  cst:                     string
  name:                    string
  description:             string
  validFrom:               string        // AAAA-MM-DD
  validUntil:              string | null
  requiresRegularTaxation: boolean
  updatedAt:               string        // DataAtualização
  /** Modelos de documento do NOSSO domínio em que a classificação é aceita. */
  models:                  Array<'SE' | '55' | '65'>
}

export interface PlaceIndicatorRecord {
  code:        string
  description: string
  models:      Array<'SE' | '55'>
}

export interface NbsRecord { code: string; description: string }

export interface ItCatalog { csts: CstRecord[]; classifications: ClassificationRecord[] }

/** Limites = colunas do DDL (prompt_fase_ibs_cbs-ddl-ib1-rascunho.sql v2). */
export const LIMITS = {
  cstDescription:            255,
  classificationName:        255,
  classificationDescription: 2000,
  placeIndicatorDescription: 1000,
  nbsDescription:            255,
} as const

const str = (v: CellValue): string => (v == null ? '' : String(v)).trim()

/** Normaliza o cabeçalho: sem acento, minúsculo, sem espaço — tolera grafia oficial. */
function key(v: CellValue): string {
  return str(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '')
}

function findSheet(sheets: XlsxSheet[], required: string[], label: string): { sheet: XlsxSheet; header: number; col: Record<string, number> } {
  for (const sheet of sheets) {
    for (let h = 0; h < Math.min(sheet.rows.length, 10); h++) {
      const row = sheet.rows[h] ?? []
      const col: Record<string, number> = {}
      row.forEach((c, i) => { const k = key(c); if (k && !(k in col)) col[k] = i })
      if (required.every(r => key(r) in col)) return { sheet, header: h, col }
    }
  }
  throw new CatalogSourceError(`${label}: estrutura oficial não reconhecida — faltam colunas obrigatórias`,
    [`colunas exigidas: ${required.join(', ')}`])
}

/** 'AAAA-MM-DD' que EXISTE no calendário (2026-02-30 e 2026-13-45 não existem). */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** Data da fonte: serial do Excel, 'AAAA-MM-DD' (hora opcional) ou 'DD/MM/AAAA' — com ÂNCORA
 *  e conferência de calendário (gate adversarial da IB-1: '2026-01-01 lixo' passava e
 *  '2026-13-45' virava "IT desatualizado"). Inválida = 'INVALID' (o chamador lista a linha). */
function dateOf(v: CellValue): string | null {
  if (v == null || str(v) === '') return null
  if (typeof v === 'number') {
    try { return excelSerialToIsoDate(v) } catch { return 'INVALID' }
  }
  const s = str(v)
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/.exec(s)
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  const out = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : br ? `${br[3]}-${br[2]}-${br[1]}` : null
  return out && isCalendarDate(out) ? out : 'INVALID'
}

function flag01(v: CellValue): 0 | 1 | null {
  const s = str(v)
  if (s === '0') return 0
  if (s === '1') return 1
  return null
}

const IT_CLASS_COLS = ['CST-IBS/CBS', 'cClassTrib', 'Nome cClassTrib', 'Descrição cClassTrib', 'ind_gTribRegular',
  'dIniVig', 'dFimVig', 'DataAtualização', 'indNFe', 'indNFCe', 'indNFSe'] as const
const IT_CST_COLS = ['CST-IBS/CBS', 'Descrição CST-IBS/CBS', 'ind_gIBSCBS'] as const

/** Tabela oficial do cClassTrib (IT 2025.002) → CSTs + classificações validadas. */
export function parseItCatalog(sheets: XlsxSheet[]): ItCatalog {
  const problems: string[] = []

  const cstSheet = findSheet(sheets, [...IT_CST_COLS], 'IT/CST')
  const csts: CstRecord[] = []
  const cstSeen = new Set<string>()
  for (let r = cstSheet.header + 1; r < cstSheet.sheet.rows.length; r++) {
    const row = cstSheet.sheet.rows[r] ?? []
    const id = str(row[cstSheet.col[key('CST-IBS/CBS')]])
    if (!id) continue
    const description = str(row[cstSheet.col[key('Descrição CST-IBS/CBS')]])
    const where = `CST linha ${r + 1}`
    if (!/^\d{3}$/.test(id)) { problems.push(`${where}: CST "${id}" não tem 3 dígitos`); continue }
    if (!description) problems.push(`${where}: descrição vazia`)
    if (description.length > LIMITS.cstDescription) problems.push(`${where}: descrição com ${description.length} > ${LIMITS.cstDescription}`)
    if (cstSeen.has(id)) { problems.push(`${where}: CST ${id} repetido`); continue }
    cstSeen.add(id)
    csts.push({ id, description })
  }

  const cls = findSheet(sheets, [...IT_CLASS_COLS], 'IT/cClassTrib')
  const c = (name: string) => cls.col[key(name)]
  const classifications: ClassificationRecord[] = []
  const seen = new Set<string>()
  for (let r = cls.header + 1; r < cls.sheet.rows.length; r++) {
    const row = cls.sheet.rows[r] ?? []
    const code = str(row[c('cClassTrib')])
    if (!code) continue
    const where = `cClassTrib linha ${r + 1} (${code})`
    const cst = str(row[c('CST-IBS/CBS')])
    const name = str(row[c('Nome cClassTrib')])
    const description = str(row[c('Descrição cClassTrib')])
    const regular = flag01(row[c('ind_gTribRegular')])
    const validFrom = dateOf(row[c('dIniVig')])
    const validUntil = dateOf(row[c('dFimVig')])
    const updatedAt = dateOf(row[c('DataAtualização')])
    const inds = { SE: flag01(row[c('indNFSe')]), '55': flag01(row[c('indNFe')]), '65': flag01(row[c('indNFCe')]) }

    if (!/^\d{6}$/.test(code)) { problems.push(`${where}: código não tem 6 dígitos`); continue }
    if (cst !== code.slice(0, 3)) problems.push(`${where}: CST "${cst}" ≠ prefixo do código (E0959)`)
    if (!cstSeen.has(cst)) problems.push(`${where}: CST ${cst} ausente da aba de CST`)
    if (!name) problems.push(`${where}: nome vazio`)
    if (name.length > LIMITS.classificationName) problems.push(`${where}: nome com ${name.length} > ${LIMITS.classificationName}`)
    if (!description) problems.push(`${where}: descrição vazia`)
    if (description.length > LIMITS.classificationDescription) problems.push(`${where}: descrição com ${description.length} > ${LIMITS.classificationDescription}`)
    if (regular === null) problems.push(`${where}: ind_gTribRegular "${str(row[c('ind_gTribRegular')])}" não é 0/1`)
    if (!validFrom || validFrom === 'INVALID') problems.push(`${where}: dIniVig ausente/inválida`)
    if (validUntil === 'INVALID') problems.push(`${where}: dFimVig inválida`)
    if (validFrom && validFrom !== 'INVALID' && validUntil && validUntil !== 'INVALID' && validUntil < validFrom) problems.push(`${where}: dFimVig antes de dIniVig`)
    if (!updatedAt || updatedAt === 'INVALID') problems.push(`${where}: DataAtualização ausente/inválida`)
    for (const [m, v] of Object.entries(inds)) if (v === null) problems.push(`${where}: indicador do modelo ${m} não é 0/1`)
    const k = `${code}|${validFrom}`
    if (seen.has(k)) { problems.push(`${where}: (código, dIniVig) repetido`); continue }
    seen.add(k)

    classifications.push({
      code, cst, name, description,
      validFrom: validFrom ?? '', validUntil: validUntil && validUntil !== 'INVALID' ? validUntil : null,
      requiresRegularTaxation: regular === 1,
      updatedAt: updatedAt ?? '',
      // Ordem EXPLÍCITA: chave numérica ('55') vem antes de 'SE' em Object.entries.
      models: (['SE', '55', '65'] as const).filter(m => inds[m] === 1),
    })
  }
  if (classifications.length === 0) problems.push('nenhuma classificação lida')
  if (problems.length) throw new CatalogSourceError('Tabela oficial do cClassTrib recusada', problems)
  return { csts, classifications }
}

const INDOP_LOCAL = 'Local do fornecimento a ser identificado no DFe'
const INDOP_COLS = ['Código indOp', 'Tipo de operação', 'Característica do fornecimento', INDOP_LOCAL, 'indNFe', 'indNFSe'] as const

/** Anexo VII da NFS-e (cIndOp) → indicadores validados. */
export function parsePlaceIndicators(sheets: XlsxSheet[]): PlaceIndicatorRecord[] {
  const problems: string[] = []
  const s = findSheet(sheets, [...INDOP_COLS], 'Anexo VII/cIndOp')
  const c = (name: string) => s.col[key(name)]
  const out: PlaceIndicatorRecord[] = []
  const seen = new Set<string>()
  for (let r = s.header + 1; r < s.sheet.rows.length; r++) {
    const row = s.sheet.rows[r] ?? []
    const raw = str(row[c('Código indOp')])
    if (!raw) continue
    const code = /^\d+$/.test(raw) ? raw.padStart(6, '0') : raw
    const where = `cIndOp linha ${r + 1} (${raw})`
    const tipo = str(row[c('Tipo de operação')])
    const carac = str(row[c('Característica do fornecimento')])
    // O LOCAL do fornecimento é o que distingue os pares (100301 adquirente × 100302
    // destinatário — 7 pares idênticos sem ele; achado do passeio logado da IB-1). O DDL
    // (script 61) já documentava "tipo + característica + local" (máx. oficial 535).
    const local = str(row[c(INDOP_LOCAL)])
    const description = [tipo, carac, local].filter(Boolean).join(' — ')
    if (!/^\d{6}$/.test(code)) { problems.push(`${where}: código não tem 6 dígitos`); continue }
    if (!description) problems.push(`${where}: descrição vazia`)
    if (description.length > LIMITS.placeIndicatorDescription) problems.push(`${where}: descrição com ${description.length} > ${LIMITS.placeIndicatorDescription}`)
    if (seen.has(code)) { problems.push(`${where}: código repetido`); continue }
    seen.add(code)
    // Vocabulário FECHADO (a planilha oficial usa "S" ou vazio): qualquer outro valor é
    // estrutura mudada — sem isto "Sim" desativava em silêncio toda a aplicabilidade do
    // cIndOp na NFS-e (gate adversarial da IB-1).
    const yes = (v: CellValue, col: string): boolean => {
      const t = str(v).toUpperCase()
      if (t === 'S') return true
      if (t === '' || t === 'N') return false
      problems.push(`${where}: ${col} "${str(v)}" não é S/N/vazio`)
      return false
    }
    const models: Array<'SE' | '55'> = []
    if (yes(row[c('indNFSe')], 'indNFSe')) models.push('SE')
    if (yes(row[c('indNFe')], 'indNFe')) models.push('55')
    out.push({ code, description, models })
  }
  if (out.length === 0) problems.push('nenhum cIndOp lido')
  if (problems.length) throw new CatalogSourceError('Anexo VII (cIndOp) recusado', problems)
  return out
}

/** Lista de NBS (dados abertos da Calculadora: [{codigo, descricao}]) → validada. */
export function parseNbsList(json: unknown): NbsRecord[] {
  if (!Array.isArray(json)) throw new CatalogSourceError('Lista de NBS recusada: não é um array')
  const problems: string[] = []
  const out: NbsRecord[] = []
  const seen = new Set<string>()
  json.forEach((item: any, i) => {
    const code = String(item?.codigo ?? '').trim()
    const description = String(item?.descricao ?? '').trim()
    const where = `NBS item ${i + 1} (${code})`
    if (!/^\d{9}$/.test(code)) { problems.push(`${where}: código não tem 9 dígitos`); return }
    if (!description) problems.push(`${where}: descrição vazia`)
    if (description.length > LIMITS.nbsDescription) problems.push(`${where}: descrição com ${description.length} > ${LIMITS.nbsDescription}`)
    if (seen.has(code)) { problems.push(`${where}: repetida`); return }
    seen.add(code)
    out.push({ code, description })
  })
  if (out.length === 0) problems.push('nenhuma NBS lida')
  if (problems.length) throw new CatalogSourceError('Lista de NBS recusada', problems)
  return out
}

/** Códigos de classificação vigentes numa data, segundo o IT. */
export function itCodesValidAt(catalog: ItCatalog, date: string): Set<string> {
  return new Set(catalog.classifications
    .filter(c => c.validFrom <= date && (c.validUntil === null || c.validUntil >= date))
    .map(c => c.code))
}
