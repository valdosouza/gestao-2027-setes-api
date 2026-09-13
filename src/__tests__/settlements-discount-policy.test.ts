/// <reference types="jest" />
// D-G32 (Q-G32, Valdo 2026-09-13): teto do desconto por config da institution;
// o privilégio DESCONTO autoriza e bypassa; admin passa; sem desconto nada é lido.
import { assertDiscountPolicy, assertDiscountAliquot } from '../modules/settlements/settlements.discount-policy'
import { userHasPrivilege } from '../shared/auth/require-privilege'
import { getConfigContent } from '../shared/interface-config'

jest.mock('../shared/auth/require-privilege', () => ({ __esModule: true, userHasPrivilege: jest.fn() }))
jest.mock('../shared/interface-config', () => ({ __esModule: true, getConfigContent: jest.fn() }))
const priv = userHasPrivilege as jest.Mock
const cfg = getConfigContent as jest.Mock
const regular = { institutionId: 1, userId: 266, role: 'user', schemaName: 'setes_setes' }
const admin = { institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }

beforeEach(() => jest.clearAllMocks())

describe('assertDiscountPolicy', () => {
  it('sem desconto no lote → passa sem consultar privilégio nem config', async () => {
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 0 }, {}])).resolves.toBeUndefined()
    expect(priv).not.toHaveBeenCalled(); expect(cfg).not.toHaveBeenCalled()
  })
  it('admin passa com qualquer desconto', async () => {
    await expect(assertDiscountPolicy(admin as any, [{ discountAliquot: 99.99 }])).resolves.toBeUndefined()
    expect(priv).not.toHaveBeenCalled()
  })
  it('regular COM privilégio DESCONTO bypassa o teto (config nem é lida)', async () => {
    priv.mockResolvedValueOnce(true)
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 50 }])).resolves.toBeUndefined()
    expect(priv).toHaveBeenCalledWith('setes_setes', 266, 'settlements', 8)
    expect(cfg).not.toHaveBeenCalled()
  })
  it('regular SEM privilégio: dentro do teto passa; acima → 403 DISCOUNT_REQUIRES_PRIVILEGE com expected', async () => {
    priv.mockResolvedValue(false)
    cfg.mockResolvedValue('5')
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 5 }, { discountAliquot: 2 }])).resolves.toBeUndefined()
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 5.01 }]))
      .rejects.toMatchObject({ statusCode: 403, code: 'DISCOUNT_REQUIRES_PRIVILEGE', fields: [{ field: 'discountAliquot', expected: 5 }] })
  })
  it('L-2 (adversarial R6): comparação em CENTAVOS da alíquota — 5.000000001 não passa de 5; 5,005 (→ 5,01) recusa', async () => {
    priv.mockResolvedValue(false)
    cfg.mockResolvedValue('5')
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 5.000000001 }])).resolves.toBeUndefined()
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 5.005 }]))
      .rejects.toMatchObject({ statusCode: 403 })
  })
  it('D-G36: a carteira de cobrança usa a MESMA política, conferindo o privilégio na interface DELA', async () => {
    priv.mockResolvedValue(false)
    cfg.mockResolvedValue('5')
    await expect(assertDiscountAliquot(regular as any, 10, 'bank-charge-agreements'))
      .rejects.toMatchObject({ statusCode: 403, code: 'DISCOUNT_REQUIRES_PRIVILEGE' })
    expect(priv).toHaveBeenCalledWith('setes_setes', 266, 'bank-charge-agreements', 8)
    priv.mockResolvedValue(true)
    await expect(assertDiscountAliquot(regular as any, 100, 'bank-charge-agreements')).resolves.toBeUndefined()
    await expect(assertDiscountAliquot(regular as any, 0, 'bank-charge-agreements')).resolves.toBeUndefined()
  })

  it('teto NEGATIVO na config vale 0 (nenhum desconto sem o privilégio)', async () => {
    priv.mockResolvedValue(false)
    cfg.mockResolvedValue('-5')
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 0.01 }]))
      .rejects.toMatchObject({ statusCode: 403, fields: [{ expected: 0 }] })
  })
  it('config ausente ou 0 = nenhum desconto sem o privilégio (fiel ao BX-15)', async () => {
    priv.mockResolvedValue(false)
    cfg.mockResolvedValueOnce(null)
    await expect(assertDiscountPolicy(regular as any, [{ discountAliquot: 0.01 }])).rejects.toMatchObject({ statusCode: 403 })
  })
})
