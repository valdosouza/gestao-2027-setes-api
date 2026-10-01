import { HttpError, FieldError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { isValidIsoDate, stripNonDigits } from '@shared/validation'
import { round2 } from '@shared/money'
import { escapeLike } from './escape-like'
import { DEFAULT_TIME_ZONE, dayStartUtc, nextDay } from '@shared/time-zone'

/**
 * PESQUISA AVANÇADA (Infra-IA/prompts/prompt_pesquisa_avancada.md, D-BA1…D-BA15).
 *
 * O módulo DECLARA em que coisas a sua lista pode ser estreitada (catálogo em
 * código — D-BA2, lista branca); o usuário manda só os VALORES
 * (`?criteria=<json>` no MESMO GET da lista — D-BA1). A peça compila os valores
 * num fragmento `AND (...)` já parametrizado que o repository anexa depois do
 * WHERE que ELE escopou (institution, carteira, soft delete) — o AND só
 * ESTREITA: nenhum critério alarga escopo, por construção (parecer do guardião).
 *
 * Regras da forma (parecer do guardião, 2026-09-30):
 * - o módulo fornece só a EXPRESSÃO; o OPERADOR é da peça, decidido pelo kind
 *   (D-BA4) — o módulo nunca escreve o predicado;
 * - expressão sobre OUTRA tabela é `EXISTS`/subselect correlacionado que carrega
 *   `tb_institution_id` e `deleted = 'N'` do alvo — JOIN só para critério
 *   duplicaria linhas e inflaria o COUNT (D2 da paginação);
 * - `expr` NUNCA sai da API: a rota `/search-criteria` serializa por lista
 *   branca (`publicCriteria`);
 * - o JSON cru nunca chega ao repository.
 */

export type CriterionKind =
  | 'text'     // contém (LIKE com escapeLike); várias expressões = OU entre elas
  | 'number'   // faixa de…até
  | 'money'    // faixa de…até, normalizada pela peça money (o que valida é o que grava)
  | 'date'     // faixa de…até (YYYY-MM-DD, fim inclusivo — vale para DATE e DATETIME)
  | 'lookup'   // igualdade com o id escolhido na lista de apoio do PRÓPRIO módulo
  | 'options'  // um ou mais valores do domínio declarado
  | 'bool'     // tri-estado: ausente = ignora; true/false

export interface SearchCriterion {
  key:       string
  kind:      CriterionKind
  /** Chave i18n do rótulo (`search.<modulo>.<key>`) — o app traduz. */
  labelKey:  string
  /** Expressão SQL confiável (código). `text` aceita várias (OU). NUNCA sai da API. */
  expr:      string | readonly string[]
  /** `lookup`: caminho da lista de apoio do PRÓPRIO módulo (ex.: '/api/customers/salesman-lookup'). */
  lookup?:   string
  /** `options`: domínio permitido — reusar a constante do enum do dto/domínio. */
  options?:  readonly string[]
  /** `text`: compara só os dígitos (documento) — o valor é normalizado. */
  digits?:   boolean
  /** `bool`: valores gravados para sim/não (ex.: ['S','N']). Ausente = `expr`
   *  já é um predicado booleano (critério derivado, sempre EXISTS escopado). */
  boolValues?: readonly [string, string]
  /** `date`: como a coluna guarda (Q-BA14, parecer do guardião). 'date' (default) já
   *  é dia de calendário — compara direto; 'datetime' é INSTANTE — as PONTAS da faixa
   *  são convertidas (o dia na zona do estabelecimento → instante UTC → fuso da sessão
   *  do banco); a coluna nunca é convertida (índice preservado). */
  storage?:  'date' | 'datetime'
}

/** Projeção pública (o que o app recebe) — lista branca de propriedades. */
export interface PublicSearchCriterion {
  key:      string
  kind:     CriterionKind
  labelKey: string
  lookup?:  string
  options?: readonly string[]
}

/** Fragmento compilado que o repository anexa ao WHERE (sempre começa com AND). */
export interface CompiledCriteria {
  sql:     string
  params:  unknown[]
  /** Chaves efetivamente aplicadas (diagnóstico/teste). */
  applied: string[]
}

export const NO_CRITERIA: CompiledCriteria = Object.freeze({ sql: '', params: [], applied: [] }) as CompiledCriteria

/** Teto do parâmetro (D-BA1: 400 legível, nunca 500/414 do proxy). */
export const MAX_CRITERIA_LENGTH = 2000
export const MAX_CRITERIA_KEYS   = 20
export const MAX_TEXT_LENGTH     = 100
/** Teto de magnitude das faixas numéricas (gate socrático H1, 2026-09-30):
 *  cabe em DECIMAL(15,2) e em BIGINT com folga; acima disso `round2` estoura
 *  para Infinity e o mysql2 escreve `Infinity` cru no SQL (500). O valor é
 *  conferido DEPOIS de normalizado — o que vai ao banco é o que foi validado. */
export const MAX_RANGE_MAGNITUDE = 1e13

export function publicCriteria(defs: readonly SearchCriterion[]): PublicSearchCriterion[] {
  return defs.map(d => ({
    key: d.key, kind: d.kind, labelKey: d.labelKey,
    ...(d.lookup  ? { lookup: d.lookup } : {}),
    ...(d.options ? { options: [...d.options] } : {}),
  }))
}

function invalidRequest(message: string): HttpError {
  return new HttpError(400, message, undefined, ErrorCodes.SEARCH_CRITERIA_INVALID)
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

type Range = { from: number | string | null; to: number | string | null }

/** Lê {from,to}; ambos vazios = critério ignorado (null). */
function readRange(
  key: string, raw: unknown, errors: FieldError[],
  parse: (v: unknown) => number | string | null
): Range | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ field: key, message: 'Informe uma faixa { from, to }' })
    return null
  }
  const r = raw as Record<string, unknown>
  const from = isEmpty(r.from) ? null : parse(r.from)
  const to   = isEmpty(r.to)   ? null : parse(r.to)
  if ((!isEmpty(r.from) && from === null) || (!isEmpty(r.to) && to === null)) {
    errors.push({ field: key, message: 'Valor da faixa inválido' })
    return null
  }
  if (from === null && to === null) return null
  if (from !== null && to !== null && from > to) {
    errors.push({ field: key, message: 'O início da faixa é maior que o fim' })
    return null
  }
  return { from, to }
}

const representable = (n: number): number | null =>
  Number.isFinite(n) && Math.abs(n) <= MAX_RANGE_MAGNITUDE ? n : null

const parseNumber = (v: unknown): number | null => {
  // string só em decimal simples — Number() aceitaria '0x10', '1e3', ' 5 ' (LOW do adversarial)
  const n = typeof v === 'number' ? v
    : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN
  return representable(n)
}
const parseMoney = (v: unknown): number | null => {
  const n = parseNumber(v)
  return n === null ? null : representable(round2(n))
}
// MEDIUM do adversarial (onda TZ-1): ano fora de 1900–9998 = 422 — '9999-12-31' fazia
// nextDay devolver '+010000-01' e dayStartUtc lançar RangeError (500)
const parseDate = (v: unknown): string | null =>
  typeof v === 'string' && isValidIsoDate(v) && v >= '1900-01-01' && v <= '9998-12-31' ? v : null

function exprOf(def: SearchCriterion): string {
  return Array.isArray(def.expr) ? (def.expr as string[])[0] : (def.expr as string)
}

/**
 * Compila os valores recebidos contra a lista branca do módulo.
 * - JSON malformado, chave desconhecida, excesso de chaves/tamanho → 400
 *   SEARCH_CRITERIA_INVALID;
 * - valor inválido → 422 SEARCH_CRITERION_INVALID com `fields[]` = chave do critério;
 * - valor vazio (null, '', [], faixa sem pontas) = critério não informado.
 */
export function compileCriteria(
  raw: unknown, defs: readonly SearchCriterion[] | undefined,
  zone: string = DEFAULT_TIME_ZONE
): CompiledCriteria {
  if (raw === undefined || raw === '') return NO_CRITERIA
  if (typeof raw !== 'string') {
    throw invalidRequest(Array.isArray(raw)
      ? 'Parâmetro criteria deve aparecer uma única vez'
      : 'Parâmetro criteria deve ser um JSON em texto (criteria=<json>)')
  }
  if (raw.length > MAX_CRITERIA_LENGTH) throw invalidRequest('Pesquisa avançada grande demais')

  let values: unknown
  try { values = JSON.parse(raw) } catch { throw invalidRequest('Parâmetro criteria não é um JSON válido') }
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw invalidRequest('Parâmetro criteria deve ser um objeto { chave: valor }')
  }
  const entries = Object.entries(values as Record<string, unknown>)
  if (entries.length > MAX_CRITERIA_KEYS) throw invalidRequest('Critérios demais na pesquisa avançada')

  const byKey = new Map((defs ?? []).map(d => [d.key, d]))
  const unknown = entries.map(([k]) => k).filter(k => !byKey.has(k))
  if (unknown.length) {
    throw new HttpError(400, `Critério de pesquisa desconhecido: ${unknown.join(', ')}`,
      unknown.map(k => ({ field: k, message: 'Critério não existe nesta tela' })),
      ErrorCodes.SEARCH_CRITERIA_INVALID)
  }

  const parts: string[] = []
  const params: unknown[] = []
  const applied: string[] = []
  const errors: FieldError[] = []

  for (const [key, value] of entries) {
    if (isEmpty(value)) continue
    const def = byKey.get(key)!
    switch (def.kind) {
      case 'text': {
        if (typeof value !== 'string') { errors.push({ field: key, message: 'Informe um texto' }); break }
        let text = value.trim()
        if (text === '') break
        if (def.digits) {
          text = stripNonDigits(text)
          // L1 do gate socrático: "abc" num critério de dígitos não pode virar "sem critério"
          // (a lista voltaria inteira com o chip dizendo o contrário)
          if (text === '') { errors.push({ field: key, message: 'Informe só números' }); break }
        }
        if (text.length > MAX_TEXT_LENGTH) { errors.push({ field: key, message: `Máximo de ${MAX_TEXT_LENGTH} caracteres` }); break }
        const exprs = Array.isArray(def.expr) ? def.expr as string[] : [def.expr as string]
        const like = `%${escapeLike(text)}%`
        parts.push(`(${exprs.map(e => `${e} LIKE ?`).join(' OR ')})`)
        exprs.forEach(() => params.push(like))
        applied.push(key)
        break
      }
      case 'number':
      case 'money':
      case 'date': {
        const parse = def.kind === 'number' ? parseNumber : def.kind === 'money' ? parseMoney : parseDate
        const range = readRange(key, value, errors, parse)
        if (!range) break
        const e = exprOf(def)
        if (def.kind === 'date' && def.storage === 'datetime') {
          // instante: [início do dia `from` na zona, início do dia seguinte a `to` na zona)
          const toSession = `CONVERT_TZ(?, '+00:00', @@session.time_zone)`
          if (range.from !== null) { parts.push(`${e} >= ${toSession}`); params.push(dayStartUtc(String(range.from), zone)) }
          if (range.to !== null) { parts.push(`${e} < ${toSession}`); params.push(dayStartUtc(nextDay(String(range.to)), zone)) }
          applied.push(key)
          break
        }
        if (range.from !== null) { parts.push(`${e} >= ?`); params.push(range.from) }
        if (range.to !== null) {
          // data: fim INCLUSIVO também para DATETIME (< dia seguinte)
          if (def.kind === 'date') parts.push(`${e} < DATE_ADD(?, INTERVAL 1 DAY)`)
          else parts.push(`${e} <= ?`)
          params.push(range.to)
        }
        applied.push(key)
        break
      }
      case 'lookup': {
        const id = parseNumber(value)
        if (id === null || !Number.isSafeInteger(id) || id <= 0) { errors.push({ field: key, message: 'Registro escolhido inválido' }); break }
        parts.push(`${exprOf(def)} = ?`)
        params.push(id)
        applied.push(key)
        break
      }
      case 'options': {
        const list = Array.isArray(value) ? value : [value]
        const allowed = def.options ?? []
        const bad = list.filter(v => typeof v !== 'string' || !allowed.includes(v))
        if (bad.length) { errors.push({ field: key, message: `Opção inválida (permitidas: ${allowed.join(', ')})` }); break }
        const uniq = [...new Set(list as string[])]
        parts.push(`${exprOf(def)} IN (${uniq.map(() => '?').join(', ')})`)
        params.push(...uniq)
        applied.push(key)
        break
      }
      case 'bool': {
        if (typeof value !== 'boolean') { errors.push({ field: key, message: 'Informe sim ou não' }); break }
        if (def.boolValues) {
          parts.push(`${exprOf(def)} = ?`)
          params.push(value ? def.boolValues[0] : def.boolValues[1])
        } else {
          parts.push(value ? `(${exprOf(def)})` : `NOT (${exprOf(def)})`)
        }
        applied.push(key)
        break
      }
    }
  }

  if (errors.length) {
    throw new HttpError(422, 'Critério da pesquisa avançada inválido', errors,
      ErrorCodes.SEARCH_CRITERION_INVALID)
  }
  if (!parts.length) return NO_CRITERIA
  return { sql: ` AND (${parts.join(' AND ')})`, params, applied }
}
