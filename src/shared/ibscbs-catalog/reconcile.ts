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

export interface ReconcileResult {
  date:          string
  itValid:       number
  calculator:    number
  /** Datas consultadas na Calculadora (a da carga primeiro). */
  dates:         string[]
  /** Linhas de vigência sem confirmação da Calculadora — carregadas SEM aplicabilidade. */
  unconfirmed:   UnconfirmedRow[]
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
 */
export function reconcileWithCalculator(
  catalog: ItCatalog,
  calculator: ReadonlyMap<string, Iterable<string>> | Iterable<string>,
  date: string,
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
  const onlyCalc = [...calc].filter(c => !it.has(c)).sort()
  if (onlyCalc.length) {
    throw new CatalogSourceError(
      `A Calculadora tem cClassTrib vigentes em ${date} que a tabela do IT não tem — o IT informado está desatualizado; carga recusada`,
      onlyCalc.map(c => `cClassTrib ${c}`))
  }
  const unconfirmed: UnconfirmedRow[] = []
  for (const row of catalog.classifications) {
    const at = conferenceDateOf(row, date)
    if (!byDate.get(at)?.has(row.code)) unconfirmed.push({ code: row.code, validFrom: row.validFrom, conferredAt: at })
  }
  unconfirmed.sort((a, b) => a.code.localeCompare(b.code) || a.validFrom.localeCompare(b.validFrom))
  return {
    date, itValid: it.size, calculator: calc.size,
    dates: [date, ...[...byDate.keys()].filter(d => d !== date).sort()],
    unconfirmed,
  }
}
