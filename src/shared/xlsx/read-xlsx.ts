import { unzipSync, strFromU8 } from 'fflate'
import { DOMParser } from '@xmldom/xmldom'

/**
 * Peça @shared/xlsx — leitor MÍNIMO de planilha .xlsx (Office Open XML), só valores.
 * Nasceu na IB-1 da fase IBS/CBS (prompt_fase_ibs_cbs.md §10.5 — D-IB23): a tabela
 * oficial do cClassTrib, o Anexo VII (cIndOp) e afins são publicados em xlsx.
 *
 * Arquivo baixado é DADO NÃO CONFIÁVEL: o leitor recusa zip acima do teto
 * descompactado (zip bomb) e nunca avalia fórmula — devolve o valor CACHEADO
 * (`<v>`) que a própria planilha gravou. Datas chegam como número serial do Excel
 * (sistema 1900) — quem conhece a coluna converte com `excelSerialToIsoDate`.
 */

export type CellValue = string | number | null

export interface XlsxSheet {
  name: string
  /** Linhas na ordem da planilha; cada linha indexada pela COLUNA (A=0, B=1…). */
  rows: CellValue[][]
}

/** Teto padrão do conteúdo descompactado (a tabela oficial inteira tem ~2 MB). */
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024

/** Limites do próprio formato (Excel 2007+): 1.048.576 linhas × 16.384 colunas (XFD).
 *  Referência fora deles é dado forjado — sem esta guarda, um arquivo de 5 KB com
 *  `<row r="300000000">` ou célula `ZZZZZZ1` fazia o leitor alocar centenas de milhões
 *  de posições (heap out of memory, sem mensagem — gate adversarial da IB-1). */
export const MAX_ROWS = 1_048_576
export const MAX_COLUMNS = 16_384

/** ORÇAMENTO de memória: posições que o leitor materializa (Σ largura das linhas + linhas),
 *  somado em TODAS as abas. Os limites do formato não bastam: 20 mil linhas com uma célula
 *  na coluna XFD cabem neles e viravam 2,7 GB de heap (re-score socrático da IB-1). As
 *  tabelas oficiais (IT ~173 × 15, Anexo VII 40 × 10) ficam três ordens de grandeza abaixo. */
export const DEFAULT_MAX_POSITIONS = 2_000_000

export class XlsxError extends Error {}

function text(node: Element | null | undefined): string {
  return node?.textContent ?? ''
}

/** "AB12" → 27 (índice zero da coluna). */
export function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref.toUpperCase())?.[0]
  if (!letters) throw new XlsxError(`Referência de célula inválida: ${ref}`)
  if (letters.length > 3) throw new XlsxError(`Coluna além do limite do formato (XFD): ${ref}`)
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  if (n > MAX_COLUMNS) throw new XlsxError(`Coluna além do limite do formato (XFD): ${ref}`)
  return n - 1
}

/** Número serial do Excel (sistema 1900) → 'AAAA-MM-DD'. Fração (hora) é descartada. */
export function excelSerialToIsoDate(serial: number): string {
  // 2958465 = 9999-12-31, o fim do calendário do Excel — acima disso é lixo (RangeError do Date)
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2958465) throw new XlsxError(`Data serial inválida: ${serial}`)
  const ms = Math.round((Math.floor(serial) - 25569) * 86400000)
  return new Date(ms).toISOString().slice(0, 10)
}

function parseXml(bytes: Uint8Array | undefined, what: string): Document {
  if (!bytes) throw new XlsxError(`Planilha sem ${what}`)
  return new DOMParser().parseFromString(strFromU8(bytes), 'text/xml')
}

/** Lê TODAS as abas do xlsx. Erro alto se a estrutura não for a de um xlsx. */
export function readXlsx(
  buffer: Uint8Array,
  maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
  maxPositions = DEFAULT_MAX_POSITIONS,
): XlsxSheet[] {
  let total = 0
  let positions = 0
  const spend = (n: number, where: string) => {
    positions += n
    if (positions > maxPositions) {
      throw new XlsxError(`Planilha larga demais: mais de ${maxPositions} posições a materializar (${where}) — dado não confiável`)
    }
  }
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(buffer, {
      filter: (f) => {
        total += f.originalSize
        if (total > maxUncompressedBytes) {
          throw new XlsxError(`Planilha acima do teto descompactado (${maxUncompressedBytes} bytes)`)
        }
        return f.name.startsWith('xl/')
      },
    })
  } catch (err) {
    if (err instanceof XlsxError) throw err
    throw new XlsxError(`Arquivo não é um xlsx válido: ${(err as Error).message}`)
  }

  const shared: string[] = []
  if (files['xl/sharedStrings.xml']) {
    const doc = parseXml(files['xl/sharedStrings.xml'], 'sharedStrings')
    const items = doc.getElementsByTagName('si')
    for (let i = 0; i < items.length; i++) {
      // texto simples (<t>) ou rico (<r><t>…</t></r>…): concatena todos os <t>
      const ts = items[i].getElementsByTagName('t')
      let s = ''
      for (let j = 0; j < ts.length; j++) s += text(ts[j])
      shared.push(s)
    }
  }

  const wb = parseXml(files['xl/workbook.xml'], 'workbook.xml')
  const rels = parseXml(files['xl/_rels/workbook.xml.rels'], 'workbook.xml.rels')
  const target: Record<string, string> = {}
  const relNodes = rels.getElementsByTagName('Relationship')
  for (let i = 0; i < relNodes.length; i++) {
    const id = relNodes[i].getAttribute('Id') ?? ''
    const t = (relNodes[i].getAttribute('Target') ?? '').replace(/^\/?xl\//, '')
    target[id] = t
  }

  const sheets: XlsxSheet[] = []
  const sheetNodes = wb.getElementsByTagName('sheet')
  for (let i = 0; i < sheetNodes.length; i++) {
    const name = sheetNodes[i].getAttribute('name') ?? `sheet${i + 1}`
    const rid = sheetNodes[i].getAttribute('r:id') ?? ''
    const path = `xl/${target[rid] ?? `worksheets/sheet${i + 1}.xml`}`
    const doc = parseXml(files[path], path)
    const rows: CellValue[][] = []
    const rowNodes = doc.getElementsByTagName('row')
    for (let r = 0; r < rowNodes.length; r++) {
      const rowNum = Number(rowNodes[r].getAttribute('r') ?? r + 1)
      if (!Number.isInteger(rowNum) || rowNum < 1 || rowNum > MAX_ROWS) {
        throw new XlsxError(`Linha fora do limite do formato (1…${MAX_ROWS}) na aba ${name}: ${rowNodes[r].getAttribute('r')}`)
      }
      const row: CellValue[] = []
      const cells = rowNodes[r].getElementsByTagName('c')
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c]
        const ref = cell.getAttribute('r')
        const col = ref ? columnIndex(ref) : row.length
        const type = cell.getAttribute('t')
        const v = cell.getElementsByTagName('v')[0]
        let value: CellValue = null
        if (type === 's') {
          value = shared[Number(text(v))] ?? null
        } else if (type === 'inlineStr') {
          const ts = cell.getElementsByTagName('t')
          let s = ''
          for (let j = 0; j < ts.length; j++) s += text(ts[j])
          value = s
        } else if (type === 'str' || type === 'e') {
          value = v ? text(v) : null
        } else if (type === 'b') {
          value = v ? Number(text(v)) : null
        } else if (v) {
          const raw = text(v)
          const n = Number(raw)
          value = raw.trim() !== '' && Number.isFinite(n) ? n : raw
        }
        row[col] = value
      }
      spend(row.length, `aba ${name}, linha ${rowNum}`)   // ANTES de preencher: a linha esparsa ainda não custa
      for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = null
      rows[rowNum - 1] = row
    }
    spend(rows.length, `aba ${name}`)
    for (let k = 0; k < rows.length; k++) if (rows[k] === undefined) rows[k] = []
    sheets.push({ name, rows })
  }
  return sheets
}
