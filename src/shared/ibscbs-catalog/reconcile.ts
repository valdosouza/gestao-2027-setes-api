import { CatalogSourceError, ClassificationRecord, ItCatalog, itCodesValidAt } from './parse'

/**
 * Conferência IT × Calculadora (D-IB23 + ASSUNÇÕES A-IB1/A-IB2, prompt_fase_ibs_cbs.md §11):
 *   - código que a Calculadora tem e o IT não tem  → o IT está DESATUALIZADO: carga
 *     RECUSADA inteira (D-IB23 na letra);
 *   - código que o IT tem e a Calculadora ainda não tem (fato da IB-1: 9 códigos novos da
 *     v1.70, publicada um dia depois do banco V0059 da Calculadora) → identidade e
 *     vigência são carregadas, mas o código NÃO é oferecido em documento nenhum até a
 *     Calculadora tê-lo — a Sefin confere a NFS-e PELA Calculadora (E1539…), então
 *     oferecer seria rejeição certa. Recusar a carga inteira travaria o catálogo a cada
 *     publicação do IT (A-IB1);
 *   - a conferência é POR LINHA DE VIGÊNCIA, na data em que a linha vale mais perto da data
 *     da carga (`conferenceDateOf`): linha com dIniVig FUTURA é conferida na própria dIniVig;
 *     data sem lista da Calculadora = linha NÃO confirmada (fail-closed — A-IB2, gate
 *     socrático da IB-1: a conferência num dia só deixava a linha futura sem conferência);
 *   - lista da Calculadora VAZIA na data da carga = fonte fora do ar ou incompleta → carga
 *     RECUSADA (senão todo código viraria "não confirmado" e a aplicabilidade do catálogo
 *     inteiro sumiria em silêncio no --vai).
 */
export interface UnconfirmedRow {
  code:        string
  validFrom:   string
  /** Data em que a Calculadora foi consultada para esta linha. */
  conferredAt: string
}

/** Linha que PERDE a aplicabilidade num modelo por divergência de atributo (D-IB28 (a)). */
export interface BlockedRow extends UnconfirmedRow {
  model:  'SE'
  reason: string
}

export interface ReconcileResult {
  date:          string
  itValid:       number
  calculator:    number
  /** Datas consultadas na Calculadora (a da carga primeiro). */
  dates:         string[]
  /** Linhas de vigência sem confirmação da Calculadora — carregadas SEM aplicabilidade. */
  unconfirmed:   UnconfirmedRow[]
  /** Linhas confirmadas cujo ATRIBUTO diverge — sem aplicabilidade só no modelo (D-IB28 (a)). */
  blocked:       BlockedRow[]
  /** Divergências só INFORMATIVAS (o IT não aceita no documento e a Calculadora aceita — o IT governa). */
  divergences:   string[]
}

/** Tipo do documento da NFS-e na lista da Calculadora (`tiposDfeClassificacao[].tipo`). */
export const CALCULATOR_NFSE_TYPE = 91
/** Sigla da NFS-e no endpoint por par da Calculadora. */
export const CALCULATOR_NFSE_SIGLA = 'NFS-e'

/** Item da lista da Calculadora numa data: código + aceitação na NFS-e (D-IB28 (a)). */
export interface CalculatorEntry { code: string; nfse: boolean }

/** Atributos do par NFS-e × cClassTrib na data (endpoint por par). `requiresGroup` = `exigeGrupoIbsCbs` — o que o fisco
 *  consulta nas regras E0859/E0860/E0960/E0961 do leiaute da NT 009 (D-IB113: conferido contra o ind_gIBSCBS do CST no IT). */
export interface CalculatorPair { valid: boolean; requiresRegular: boolean; requiresGroup: boolean }

export const pairKey = (date: string, code: string): string => `${date}|${code}`

/** Lista da Calculadora com os documentos de cada código — estrutura mudada = erro ALTO. */
export function parseCalculatorList(json: unknown, date: string): CalculatorEntry[] {
  const codes = parseCalculatorCodes(json, date)
  const problems: string[] = []
  const out = (json as any[]).map((x, i) => {
    const tipos = x?.tiposDfeClassificacao
    if (!Array.isArray(tipos) || tipos.some((t: any) => typeof t?.tipo !== 'number')) {
      problems.push(`item ${i + 1} (${codes[i]}): tiposDfeClassificacao ausente ou sem "tipo" numérico`)
      return { code: codes[i], nfse: false }
    }
    return { code: codes[i], nfse: tipos.some((t: any) => t.tipo === CALCULATOR_NFSE_TYPE) }
  })
  if (problems.length) throw new CatalogSourceError(`Calculadora (${date}): estrutura da lista de cClassTrib mudou`, problems)
  return out
}

/** Resposta do par NFS-e × cClassTrib — os três booleanos que o código consome. */
export function parseCalculatorPair(json: unknown, code: string, date: string): CalculatorPair {
  const x = json as any
  if (typeof x?.validoParaSiglaDfeInformado !== 'boolean' || typeof x?.exigeGrupoTributacaoRegular !== 'boolean'
      || typeof x?.exigeGrupoIbsCbs !== 'boolean') {
    throw new CatalogSourceError(`Calculadora (${date}): resposta do par ${CALCULATOR_NFSE_SIGLA} × ${code} mudou de estrutura`,
      [JSON.stringify(x).slice(0, 200)])
  }
  return { valid: x.validoParaSiglaDfeInformado, requiresRegular: x.exigeGrupoTributacaoRegular, requiresGroup: x.exigeGrupoIbsCbs }
}

/** Linhas que pedem a consulta por PAR: aceitas na NFS-e pelo IT E pela lista da Calculadora na data delas. */
export function rowsNeedingPair(
  catalog: ItCatalog, entries: ReadonlyMap<string, readonly CalculatorEntry[]>, loadDate: string,
): Array<{ date: string; code: string }> {
  const out = new Map<string, { date: string; code: string }>()
  for (const row of catalog.classifications) {
    if (!row.models.includes('SE')) continue
    const at = conferenceDateOf(row, loadDate)
    if (entries.get(at)?.find(e => e.code === row.code)?.nfse) out.set(pairKey(at, row.code), { date: at, code: row.code })
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code))
}

/** Lista de cClassTrib da Calculadora numa data: array de objetos com `codigo` de 6 dígitos
 *  (estrutura mudada = erro ALTO — nunca vira "código desconhecido"). */
export function parseCalculatorCodes(json: unknown, date: string): string[] {
  if (!Array.isArray(json)) throw new CatalogSourceError(`Calculadora (${date}): a lista de cClassTrib não é um array`)
  const problems: string[] = []
  const codes = json.map((x: any, i) => {
    const code = String(x?.codigo ?? '').trim()
    if (!/^\d{6}$/.test(code)) problems.push(`item ${i + 1}: codigo "${code}" não tem 6 dígitos`)
    return code
  })
  if (problems.length) throw new CatalogSourceError(`Calculadora (${date}): estrutura da lista de cClassTrib mudou`, problems)
  return codes
}

/** A data dentro da vigência da linha mais próxima da data da carga. */
export function conferenceDateOf(row: Pick<ClassificationRecord, 'validFrom' | 'validUntil'>, loadDate: string): string {
  const upper = row.validUntil !== null && row.validUntil < loadDate ? row.validUntil : loadDate
  return row.validFrom > upper ? row.validFrom : upper
}

/** Datas que a carga precisa consultar na Calculadora — a da carga primeiro, depois as demais em ordem. */
export function conferenceDates(catalog: ItCatalog, loadDate: string): string[] {
  const others = new Set(catalog.classifications.map(c => conferenceDateOf(c, loadDate)))
  others.delete(loadDate)
  return [loadDate, ...[...others].sort()]
}

/**
 * `calculator`: códigos da Calculadora POR DATA consultada (ou só a lista da data da carga —
 * as demais datas ficam sem lista e as linhas delas, não confirmadas).
 * `attributes` (D-IB28 (a) — OBRIGATÓRIO: nenhum chamador pula a conferência): a lista com os documentos de cada
 * código e os PARES NFS-e × cClassTrib. Linha confirmada que o IT aceita na NFS-e perde a
 * aplicabilidade na NFS-e quando a Calculadora não a aceita (lista ou par), quando o par
 * não foi consultado (fail-closed), quando a tributação regular diverge do IT ou — D-IB113 —
 * quando o grupo IBS/CBS do par (`exigeGrupoIbsCbs`) diverge do ind_gIBSCBS do CST no IT.
 */
export function reconcileWithCalculator(
  catalog: ItCatalog,
  calculator: ReadonlyMap<string, Iterable<string>> | Iterable<string>,
  date: string,
  attributes: {
    entries: ReadonlyMap<string, readonly CalculatorEntry[]>
    pairs:   ReadonlyMap<string, CalculatorPair>
  },
): ReconcileResult {
  const byDate = new Map<string, Set<string>>()
  if (calculator instanceof Map) {
    for (const [d, codes] of calculator) byDate.set(d, new Set(codes))
  } else {
    byDate.set(date, new Set(calculator as Iterable<string>))
  }
  const calc = byDate.get(date)
  if (!calc) throw new CatalogSourceError(`Calculadora sem lista de cClassTrib na data da carga (${date}); carga recusada`)
  // Lista VAZIA em QUALQUER data consultada = recusa (re-score socrático da IB-1: a regra
  // valia só na data da carga; [] numa data de conferência futura tirava a aplicabilidade
  // da linha que passa a valer nela, sem erro). Data NÃO consultada segue fail-closed.
  const empty = [...byDate].filter(([, codes]) => codes.size === 0).map(([d]) => d).sort()
  if (empty.length) {
    throw new CatalogSourceError(
      `A Calculadora devolveu lista VAZIA de cClassTrib — fonte fora do ar ou incompleta; carga recusada (nada gravado)`,
      empty.map(d => `data ${d}`))
  }
  const it = itCodesValidAt(catalog, date)
  // A-IB1 em TODA data consultada (gate adversarial do delta): código na Calculadora fora do IT
  // naquela data = IT desatualizado → carga recusada inteira
  const onlyCalc: string[] = []
  for (const [d, codes] of [...byDate].sort(([x], [y]) => x.localeCompare(y))) {
    const itAt = d === date ? it : itCodesValidAt(catalog, d)
    for (const c of [...codes].sort()) if (!itAt.has(c)) onlyCalc.push(`cClassTrib ${c} (${d})`)
  }
  if (onlyCalc.length) {
    throw new CatalogSourceError(
      `A Calculadora tem cClassTrib vigentes que a tabela do IT não tem na mesma data — o IT informado está desatualizado; carga recusada`,
      onlyCalc)
  }
  const unconfirmed: UnconfirmedRow[] = []
  for (const row of catalog.classifications) {
    const at = conferenceDateOf(row, date)
    if (!byDate.get(at)?.has(row.code)) unconfirmed.push({ code: row.code, validFrom: row.validFrom, conferredAt: at })
  }
  unconfirmed.sort((a, b) => a.code.localeCompare(b.code) || a.validFrom.localeCompare(b.validFrom))

  const blocked: BlockedRow[] = []
  const divergences: string[] = []
  const cstGroup = new Map(catalog.csts.map(c => [c.id, c.requiresGroup]))
  {
    const isUnconfirmed = new Set(unconfirmed.map(u => `${u.code}|${u.validFrom}`))
    for (const row of catalog.classifications) {
      if (isUnconfirmed.has(`${row.code}|${row.validFrom}`)) continue
      const at = conferenceDateOf(row, date)
      const entry = attributes.entries.get(at)?.find(e => e.code === row.code)
      const itSE = row.models.includes('SE')
      const base = { code: row.code, validFrom: row.validFrom, conferredAt: at, model: 'SE' as const }
      if (!itSE) {
        if (entry?.nfse) divergences.push(`cClassTrib ${row.code} (${row.validFrom}): o IT não aceita na NFS-e e a Calculadora aceita — vale o IT`)
        continue
      }
      if (!entry?.nfse) { blocked.push({ ...base, reason: 'a lista da Calculadora não aceita na NFS-e' }); continue }
      const pair = attributes.pairs.get(pairKey(at, row.code))
      if (!pair) blocked.push({ ...base, reason: 'par NFS-e × cClassTrib não consultado na Calculadora' })
      else if (!pair.valid) blocked.push({ ...base, reason: 'o par NFS-e × cClassTrib não é válido na Calculadora' })
      else if (pair.requiresRegular !== row.requiresRegularTaxation) {
        blocked.push({ ...base, reason: `tributação regular diverge (IT ${row.requiresRegularTaxation ? 'exige' : 'não exige'} × Calculadora ${pair.requiresRegular ? 'exige' : 'não exige'})` })
      } else if (pair.requiresGroup !== cstGroup.get(row.cst)) {
        // D-IB113: o fisco decide o grupo pela Calculadora (E0961 "conforme consulta à calculadora") — divergir do IT = a linha sai da NFS-e
        blocked.push({ ...base, reason: `grupo IBS/CBS diverge (IT: CST ${row.cst} ${cstGroup.get(row.cst) ? 'exige' : 'não leva'} × Calculadora ${pair.requiresGroup ? 'exige' : 'não leva'})` })
      }
    }
    blocked.sort((a, b) => a.code.localeCompare(b.code) || a.validFrom.localeCompare(b.validFrom))
  }
  return {
    date, itValid: it.size, calculator: calc.size,
    dates: [date, ...[...byDate.keys()].filter(d => d !== date).sort()],
    unconfirmed, blocked, divergences,
  }
}
