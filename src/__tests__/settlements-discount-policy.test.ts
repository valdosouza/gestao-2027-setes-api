/// <reference types="jest" />
// D-G32 (Q-G32, Valdo 2026-09-13): teto do desconto por config da institution;
// o privilégio DESCONTO autoriza e bypassa; admin passa; sem desconto nada é lido.
// Costura A1 da auth-api (D-AU6, 2026-10-31): o DESCONTO é o veredito ÚNICO (`@shared/access` → `vw_user_access`) — o dublê
// `accessAnswer` responde à view a partir do perfil do vínculo, do contrato, dos pares registrados e das concessões.
import pool from '../shared/db/connection'
import { assertDiscountPolicy, assertDiscountAliquot } from '../modules/settlements/settlements.discount-policy'
import { getConfigContent } from '../shared/interface-config'
import { accessAnswer, AccessModel } from '../test-setup/access-model'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))
jest.mock('../shared/interface-config', () => ({ __esModule: true, getConfigContent: jest.fn() }))
const mockQuery = (pool as any).query as jest.Mock
const cfg = getConfigContent as jest.Mock
const regular = { institutionId: 1, userId: 266, role: 'user', schemaName: 'setes_setes' }
const admin = { institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }

let models: Record<number, AccessModel>
let grantedDiscount: string[]                       // interfaces em que o regular 266 tem DESCONTO concedido
function routeDb(): void {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    const a = accessAnswer(sql, params, (u: number) => {
      const m = models[u]
      return m ? { ...m, granted: u === 266 ? Object.fromEntries(grantedDiscount.map(k => [k, ['DESCONTO']])) : m.granted } : null
    })
    if (a) return [a, []]
    throw new Error(`SQL inesperado: ${sql}`)
  })
}
const verdictReads = () => mockQuery.mock.calls.filter(c => /vw_user_access/.test(String(c[0]))).map(c => c[1])

beforeEach(() => {
  jest.clearAllMocks()
  const contracted = ['settlements', 'bank-charge-agreements']
  models = {
    266: { profile: 'user', vendor: true, contracted },
    7: { profile: 'admin', vendor: true, contracted },
  }
  grantedDiscount = []
  routeDb()
})

describe('assertDiscountPolicy', () => {
  it('sem desconto no lote → passa sem consultar privilégio nem config', async () => {
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 0 }, {}])).resolves.toBeUndefined()
    expect(mockQuery).not.toHaveBeenCalled(); expect(cfg).not.toHaveBeenCalled()
  })
  it('admin passa com qualquer desconto (o veredito dá o par registrado da interface contratada) — config nem é lida', async () => {
    await expect(assertDiscountPolicy(admin as any, [{ discountAliquot: 99.99 }])).resolves.toBeUndefined()
    expect(verdictReads()).toEqual([[7, 1, ['settlements'], 'DESCONTO']])
    expect(cfg).not.toHaveBeenCalled()
  })
  it('admin SEM o par DESCONTO registrado na interface (ou fora do contrato) cai no teto como todos (veredito único — D-AU6)', async () => {
    models[7] = { profile: 'admin', vendor: true, contracted: ['settlements'], registered: { settlements: ['VISUALIZAR', 'INSERIR'] } }
    cfg.mockResolvedValue('5')
    await expect(assertDiscountPolicy(admin as any, [{ discountAliquot: 5 }])).resolves.toBeUndefined()
    await expect(assertDiscountPolicy(admin as any, [{ discountAliquot: 6 }]))
      .rejects.toMatchObject({ statusCode: 403, code: 'DISCOUNT_REQUIRES_PRIVILEGE', fields: [{ field: 'discountAliquot', expected: 5 }] })
    await expect(assertDiscountAliquot(admin as any, 6, 'bank-charge-agreements'))      // fora do contrato
      .rejects.toMatchObject({ statusCode: 403, code: 'DISCOUNT_REQUIRES_PRIVILEGE' })
  })
  it('regular COM privilégio DESCONTO bypassa o teto (config nem é lida); o veredito é no schema/institution do token', async () => {
    grantedDiscount = ['settlements']
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 50 }])).resolves.toBeUndefined()
    const acc = mockQuery.mock.calls.filter(c => /vw_user_access/.test(String(c[0])))
    expect(String(acc[0][0])).toMatch(/`setes_setes`\.vw_user_access/)
    expect(verdictReads()).toEqual([[266, 1, ['settlements'], 'DESCONTO']])
    expect(cfg).not.toHaveBeenCalled()
  })
  it('regular SEM privilégio: dentro do teto passa; acima → 403 DISCOUNT_REQUIRES_PRIVILEGE com expected', async () => {
    cfg.mockResolvedValue('5')
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 5 }, { discountAliquot: 2 }])).resolves.toBeUndefined()
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 5.01 }]))
      .rejects.toMatchObject({ statusCode: 403, code: 'DISCOUNT_REQUIRES_PRIVILEGE', fields: [{ field: 'discountAliquot', expected: 5 }] })
  })
  it('L-2 (adversarial R6): comparação em CENTAVOS da alíquota — 5.000000001 não passa de 5; 5,005 (→ 5,01) recusa', async () => {
    cfg.mockResolvedValue('5')
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 5.000000001 }])).resolves.toBeUndefined()
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 5.005 }]))
      .rejects.toMatchObject({ statusCode: 403 })
  })
  it('D-G36: a carteira de cobrança usa a MESMA política, conferindo o privilégio na interface DELA', async () => {
    grantedDiscount = ['settlements']                        // o DESCONTO da baixa NÃO vale na carteira
    cfg.mockResolvedValue('5')
    await expect(assertDiscountAliquot(regular as any, 10, 'bank-charge-agreements'))
      .rejects.toMatchObject({ statusCode: 403, code: 'DISCOUNT_REQUIRES_PRIVILEGE' })
    expect(verdictReads()).toEqual([[266, 1, ['bank-charge-agreements'], 'DESCONTO']])
    grantedDiscount = ['bank-charge-agreements']
    await expect(assertDiscountAliquot(regular as any, 100, 'bank-charge-agreements')).resolves.toBeUndefined()
    await expect(assertDiscountAliquot(regular as any, 0, 'bank-charge-agreements')).resolves.toBeUndefined()
  })

  it('teto NEGATIVO na config vale 0 (nenhum desconto sem o privilégio)', async () => {
    cfg.mockResolvedValue('-5')
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 0.01 }]))
      .rejects.toMatchObject({ statusCode: 403, fields: [{ expected: 0 }] })
  })
  it('config ausente ou 0 = nenhum desconto sem o privilégio (fiel ao BX-15)', async () => {
    cfg.mockResolvedValueOnce(null)
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 0.01 }])).rejects.toMatchObject({ statusCode: 403 })
  })
})
