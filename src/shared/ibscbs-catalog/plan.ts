import { createHash } from 'crypto'
import { ItCatalog, NbsRecord, PlaceIndicatorRecord } from './parse'
import { BlockedRow, CalculatorPair, UnconfirmedRow } from './reconcile'

/**
 * PLANO da carga do catálogo IBS/CBS (gate socrático da IB-1 — "o ato tem plano"): o hash do
 * que ESTA execução vai gravar — fontes (bytes) E registros já interpretados, conferência da
 * Calculadora por data, linhas não confirmadas e NBS. O ENSAIO imprime o plano; o --vai só
 * grava com `--plano` igual ao recalculado agora: fonte, leitura ou data mudou entre o ensaio
 * e o ato = nada gravado. O plano cobre a ENTRADA, não o estado do banco: o delta pode diferir
 * do ensaio se outra carga gravou no meio — o estado final é o mesmo (a carga é idempotente).
 */
export interface PlanInput {
  date:         string
  itFile:       string
  it:           ItCatalog
  itVersion:    string
  indopFile:    string
  indop:        PlaceIndicatorRecord[]
  indopVersion: string
  unconfirmed:  UnconfirmedRow[]
  calculator:   ReadonlyMap<string, readonly string[]>
  nbs:          NbsRecord[]
  /** D-IB28 (a): códigos aceitos na NFS-e pela lista, por data; pares consultados; linhas bloqueadas. */
  calculatorNfse?: ReadonlyMap<string, readonly string[]>
  pairs?:          ReadonlyMap<string, CalculatorPair>
  blocked?:        BlockedRow[]
  /** D-IB28 (c): --aceita-encolher faz parte do que o ensaio mostrou. */
  allowShrink?:    boolean
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

export const fileDigest = (bytes: Uint8Array): string => sha256(bytes)

export function catalogPlan(p: PlanInput): string {
  return sha256(JSON.stringify({
    date: p.date, itFile: p.itFile, it: p.it, itVersion: p.itVersion,
    indopFile: p.indopFile, indop: p.indop, indopVersion: p.indopVersion,
    unconfirmed: p.unconfirmed,
    calculator: [...p.calculator.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([d, l]) => [d, [...l].sort()]),
    nbs: [...p.nbs].sort((x, y) => x.code.localeCompare(y.code)).map(n => [n.code, n.description]),
    calculatorNfse: p.calculatorNfse && [...p.calculatorNfse.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([d, l]) => [d, [...l].sort()]),
    pairs: p.pairs && [...p.pairs.entries()].sort(([x], [y]) => x.localeCompare(y)),
    blocked: p.blocked,
    allowShrink: p.allowShrink || undefined,
  })).slice(0, 16)
}

/** Antes de qualquer leitura: --vai sem --plano e --plano sem --vai são recusados. */
/** D-IB48: o ATO (`--vai`) só grava com a data de hoje — `--date` serve para REPRODUZIR uma carga no ensaio.
 *  Limite conhecido: o ato que começa 23:59 e grava 00:01 leva a data de ontem (o plano é da mesma data). */
export function assertActDate(vai: boolean, date: string, today: string): void {
  if (vai && date !== today) {
    throw new Error(`--vai com --date ${date} recusado: o ato grava só com a data de hoje (${today}) — D-IB48; rode o ensaio sem --date`)
  }
}

export function assertPlanArgs(vai: boolean, plano: string | undefined): void {
  if (vai && plano === undefined) {
    throw new Error('--vai exige --plano <hash> — rode o ENSAIO (sem --vai) e confira o relatório antes')
  }
  if (plano !== undefined && !vai) throw new Error('--plano só vale junto com --vai')
}

/** Depois de ler e interpretar as fontes: o --vai só segue com o plano do ensaio. */
export function assertPlanMatches(vai: boolean, plano: string | undefined, computed: string, date: string): void {
  if (vai && plano !== computed) {
    throw new Error(`o plano mudou desde o ensaio (lido agora ${computed} para a data ${date} ≠ --plano ${plano}) — `
      + 'fonte, leitura ou data diferente; nada gravado — rode o ensaio de novo')
  }
}
