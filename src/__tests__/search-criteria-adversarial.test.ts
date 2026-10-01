/// <reference types="jest" />
// GATE ADVERSARIAL da Pesquisa Avançada — Onda 1 (2026-09-30)
// (Infra-IA/skills-genericas/testar-adversarial.md × prompt_pesquisa_avancada.md).
// Achado confirmado vira teste permanente; os ataques que a peça SEGUROU ficam
// como guarda de regressão.
import { format } from 'mysql2'
import { HttpError } from '../shared/errors/http-error'
import { compileCriteria, SearchCriterion } from '../shared/list'
import { CUSTOMER_SEARCH_CRITERIA } from '../modules/customers/customers.repository'
import { SERVICE_ORDER_SEARCH_CRITERIA } from '../modules/service-orders/service-orders.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

function statusOf(fn: () => unknown): { status: number; code?: string; fields?: string[] } | 'ok' {
  try { fn(); return 'ok' } catch (err) {
    if (err instanceof HttpError) {
      const e = err as any
      return { status: e.status ?? e.statusCode, code: e.code, fields: (e.fields ?? []).map((f: any) => f.field) }
    }
    throw err
  }
}

describe('ADV-1 (HIGH) — money com valor finito que estoura em centavos vira Infinity no SQL → 500', () => {
  // Provado ao vivo: GET /api/service-orders?criteria={"totalValue":{"from":1e307}}
  // → 500 INTERNAL (ref 886A8Z8X); {"totalValue":{"to":-1e307}} → 500 (ref KX6738SG).
  // Causa: parseNumber aceita 1e307 (finito), round2 → toCents faz v*100 = Infinity,
  // o param Infinity chega ao mysql2, que o escreve CRU (`>= Infinity`) → erro de
  // coluna desconhecida no MariaDB. Contrato (D-BA1): valor inválido = 422 legível.
  const cases: [string, unknown][] = [
    ['from 1e307',  { totalValue: { from: 1e307 } }],
    ['to -1e307',   { totalValue: { to: -1e307 } }],
    ['from max double', { totalValue: { from: Number.MAX_VALUE } }],
  ]
  it.each(cases)('%s → 422 SEARCH_CRITERION_INVALID (nunca param não finito)', (_label, values) => {
    const raw = JSON.stringify(values)
    let compiled: ReturnType<typeof compileCriteria> | null = null
    const r = statusOf(() => { compiled = compileCriteria(raw, SERVICE_ORDER_SEARCH_CRITERIA) })
    if (r === 'ok') {
      // se um dia a peça decidir clampar em vez de recusar, o SQL ainda tem que ser válido
      for (const p of compiled!.params) {
        if (typeof p === 'number') expect(Number.isFinite(p)).toBe(true)
      }
    } else {
      expect(r.status).toBe(422)
      expect(r.code).toBe('SEARCH_CRITERION_INVALID')
      expect(r.fields).toEqual(['totalValue'])
    }
  })

  it('mecanismo: mysql2 escreve Infinity cru no SQL (por isso o param tem de ser finito)', () => {
    expect(format('x >= ?', [Infinity])).toBe('x >= Infinity')
  })
})

describe('Propriedade — todo param numérico compilado é finito (number/money/lookup)', () => {
  const extremes = [1e307, -1e307, 1.7976931348623157e308, -1.7976931348623157e308, 5e-324, 1e21, -0]
  const numericDefs: SearchCriterion[] = [
    ...SERVICE_ORDER_SEARCH_CRITERIA.filter(d => d.kind === 'number' || d.kind === 'money'),
  ]
  for (const def of numericDefs) {
    for (const v of extremes) {
      it(`${def.key} (${def.kind}) from=${v}`, () => {
        const raw = JSON.stringify({ [def.key]: { from: v } })
        let compiled: ReturnType<typeof compileCriteria> | null = null
        const r = statusOf(() => { compiled = compileCriteria(raw, SERVICE_ORDER_SEARCH_CRITERIA) })
        if (r === 'ok') {
          for (const p of compiled!.params) {
            if (typeof p === 'number') expect(Number.isFinite(p)).toBe(true)
          }
        } else {
          expect(r.status).toBe(422)
        }
      })
    }
  }
})

describe('Guardas de regressão — ataques que a peça segurou (provados ao vivo em 2026-09-30)', () => {
  const C = (v: unknown) => compileCriteria(typeof v === 'string' ? v : JSON.stringify(v), CUSTOMER_SEARCH_CRITERIA)

  it('__proto__/constructor como chave = 400 chave desconhecida (sem prototype pollution)', () => {
    expect(statusOf(() => C('{"__proto__":{"x":1}}'))).toMatchObject({ status: 400, code: 'SEARCH_CRITERIA_INVALID', fields: ['__proto__'] })
    expect(statusOf(() => C({ constructor: 'x' }))).toMatchObject({ status: 400, fields: ['constructor'] })
    expect(({} as any).x).toBeUndefined()
  })

  it('criteria repetido/aninhado na query (array/objeto do qs) = 400', () => {
    expect(statusOf(() => compileCriteria(['{}', '{}'], CUSTOMER_SEARCH_CRITERIA))).toMatchObject({ status: 400 })
    expect(statusOf(() => compileCriteria({ a: '1' }, CUSTOMER_SEARCH_CRITERIA))).toMatchObject({ status: 400 })
  })

  it('valor de texto com aspas/LIKE vai SEMPRE em placeholder, escapado', () => {
    const c = C({ city: "'; DROP TABLE x; -- %_\\" })
    expect(c.sql).not.toContain('DROP')
    expect(c.params).toEqual(["%'; DROP TABLE x; -- \\%\\_\\\\%"])
  })

  it('options: valor fora do domínio (inclusive nomes de protótipo) = 422', () => {
    for (const bad of [['__proto__'], ['toString'], [null], [['F']], ['X']]) {
      expect(statusOf(() => C({ personType: bad }))).toMatchObject({ status: 422, fields: ['personType'] })
    }
  })

  it('options repetido é deduplicado (300× "F" = um único placeholder)', () => {
    const c = C({ personType: Array(300).fill('F') })
    expect(c.params).toEqual(['F'])
  })

  it('lookup só aceita inteiro positivo', () => {
    for (const bad of [-1, 1.5, true, { id: 1 }, [1, 2]]) {
      expect(statusOf(() => C({ salesman: bad }))).toMatchObject({ status: 422, fields: ['salesman'] })
    }
    expect(statusOf(() => C('{"salesman":1e400}'))).toMatchObject({ status: 422 })
  })

  it('datas: 29/02 fora de ano bissexto, 0000-00-00 e ISO com fuso = 422', () => {
    for (const from of ['2026-02-29', '0000-00-00', '2026-01-01T00:00:00Z']) {
      expect(statusOf(() => C({ createdAt: { from } }))).toMatchObject({ status: 422, fields: ['createdAt'] })
    }
    // createdAt é DATETIME (Q-BA14): a ponta vira o instante UTC do início do dia em America/Sao_Paulo
    expect(C({ createdAt: { from: '2024-02-29' } }).params).toEqual(['2024-02-29 03:00:00'])
  })

  it('texto acima de 100 caracteres = 422; JSON acima de 2000 = 400', () => {
    expect(statusOf(() => C({ city: 'a'.repeat(101) }))).toMatchObject({ status: 422 })
    expect(statusOf(() => C({ city: 'a'.repeat(2000) }))).toMatchObject({ status: 400 })
  })
})

describe('Re-prova da correção (2026-09-30) — bordas do teto MAX_RANGE_MAGNITUDE e do parse decimal', () => {
  const S = (v: unknown) => compileCriteria(JSON.stringify(v), SERVICE_ORDER_SEARCH_CRITERIA)
  it('teto 1e13 exato passa; 1e13+1 = 422; 9999999999999.995 fica finito e dentro do teto', () => {
    expect(S({ number: { from: 1e13 } }).params).toEqual([1e13])
    expect(statusOf(() => S({ number: { from: 1e13 + 1 } }))).toMatchObject({ status: 422 })
    const p = S({ totalValue: { from: 9999999999999.995 } }).params[0] as number
    expect(Number.isFinite(p) && p <= 1e13).toBe(true) // 15 dígitos significativos: limite do double, não da peça
  })
  it('string numérica só decimal simples', () => {
    for (const bad of ['1e3', '0x10', ' 5 ', '1.', '.5', '+5', '1,5', '١٢']) {
      expect(statusOf(() => S({ totalValue: { from: bad } }))).toMatchObject({ status: 422, fields: ['totalValue'] })
    }
    expect(S({ totalValue: { from: '00012' } }).params).toEqual([12])
  })
  it('lookup: 0, -0 e acima do teto = 422; "00005" e 5.0 = 5', () => {
    for (const bad of [0, -0, 2 ** 53, '9007199254740993']) {
      expect(statusOf(() => S({ customer: bad }))).toMatchObject({ status: 422, fields: ['customer'] })
    }
    expect(S({ customer: '00005' }).params).toEqual([5])
  })
})
