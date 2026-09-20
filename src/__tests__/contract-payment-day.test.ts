/// <reference types="jest" />
// D12/D13/D14 (Valdo 2026-09-13): o contrato de mensalidade diz QUANDO
// (`payment_day`) e COMO (`tb_payment_types_id`) o cliente paga. O que este
// teste fixa é a regra da DIVERGÊNCIA, que vale para os dois campos de forma
// INDEPENDENTE: dois contratos do mesmo cliente podem combinar no dia e
// divergir na forma. Campo que diverge vira null — escolher um seria decidir
// pelo usuário sem ele saber.
import pool from '../shared/db/connection'
import {
  contractBillingReference, contractPaymentDay,
} from '../modules/service-orders/service-orders.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
const mockQuery = (pool as any).query as jest.Mock

/** Linha do agregado que a peça consulta. */
const agregado = (over: Record<string, any> = {}) => [[{
  competence: '2026-09', dias: 1, paymentDay: 10,
  // `contratos` = COUNT(*) e `comForma` = COUNT(coluna): é a diferença entre
  // eles que denuncia contrato "informar no faturamento" (NULL) convivendo
  // com outro que combinou forma.
  contratos: 1, formas: 1, comForma: 1, paymentTypeId: 6, ...over,
}]]

beforeEach(() => jest.clearAllMocks())

describe('contractBillingReference (D12/D13/D14)', () => {
  it('contratos combinando: devolve dia, forma e a competência', async () => {
    mockQuery.mockResolvedValueOnce(agregado())
    expect(await contractBillingReference(7953, 'setes_setes', 1)).toEqual({
      paymentDay: 10, paymentTypeId: 6, competence: '2026-09',
    })
  })

  // D23 (Q-R1, Valdo 2026-09-19): editar ou excluir o contrato NÃO muda a cobrança
  // de um mês que ele já gerou — as condições vêm do FATO da competência, gravadas
  // no ato da injeção. Este teste cai se alguém voltar a ler do contrato vivo.
  it('D23: lê dia e forma do FATO da competência, sem JOIN com o contrato vivo', async () => {
    mockQuery.mockResolvedValueOnce(agregado())
    await contractBillingReference(7953, 'setes_setes', 1)
    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).toMatch(/tb_contract_item_competence comp/)
    expect(sql).toMatch(/MIN\(comp\.payment_day\)/)
    expect(sql).toMatch(/MIN\(comp\.tb_payment_types_id\)/)
    expect(sql).toMatch(/COUNT\(comp\.tb_payment_types_id\) AS comForma/)
    expect(sql).not.toMatch(/JOIN[\s\S]*tb_contract/)
    expect(sql).not.toMatch(/c\.payment_day|c\.tb_payment_types_id|c\.deleted/)
    expect(sql).toMatch(/comp\.deleted = 'N'/)
    expect(mockQuery.mock.calls[0][1]).toEqual([1, 7953])
  })

  it('DIA diverge → só o dia vira null; a forma continua valendo', async () => {
    mockQuery.mockResolvedValueOnce(agregado({ dias: 2, paymentDay: 5 }))
    expect(await contractBillingReference(7953, 'setes_setes', 1)).toEqual({
      paymentDay: null, paymentTypeId: 6, competence: '2026-09',
    })
  })

  it('FORMA diverge → só a forma vira null; o dia continua valendo', async () => {
    mockQuery.mockResolvedValueOnce(agregado({ formas: 2 }))
    expect(await contractBillingReference(7953, 'setes_setes', 1)).toEqual({
      paymentDay: 10, paymentTypeId: null, competence: '2026-09',
    })
  })

  it('nenhum contrato define a forma → forma null', async () => {
    mockQuery.mockResolvedValueOnce(agregado({ formas: 0, comForma: 0, paymentTypeId: null }))
    const r = await contractBillingReference(7953, 'setes_setes', 1)
    expect(r?.paymentTypeId).toBeNull()
    expect(r?.paymentDay).toBe(10)
  })

  // HIGH do gate adversarial: COUNT(DISTINCT) IGNORA NULL, então um contrato
  // "informar no faturamento" convivendo com outro que combinou forma fazia o
  // lote adotar a do irmão e faturar — com baixa automática e taxa numa forma
  // que o operador nunca escolheu. Sem forma em TODOS, não há forma combinada.
  it('um contrato combina forma e o OUTRO é "informar no faturamento" → forma null', async () => {
    mockQuery.mockResolvedValueOnce(agregado({
      contratos: 2, formas: 1, comForma: 1, paymentTypeId: 2,
    }))
    const r = await contractBillingReference(7953, 'setes_setes', 1)
    expect(r?.paymentTypeId).toBeNull()   // recusa; não adota a do irmão
    expect(r?.paymentDay).toBe(10)        // o dia continua valendo
  })

  it('os DOIS contratos combinam a MESMA forma → vale', async () => {
    mockQuery.mockResolvedValueOnce(agregado({
      contratos: 2, formas: 1, comForma: 2, paymentTypeId: 6,
    }))
    expect((await contractBillingReference(7953, 'setes_setes', 1))?.paymentTypeId).toBe(6)
  })

  it('ordem que NÃO veio de contrato (OS avulsa) → null inteiro', async () => {
    mockQuery.mockResolvedValueOnce([[{ competence: null, dias: 0, paymentDay: null, formas: 0, paymentTypeId: null }]])
    expect(await contractBillingReference(7953, 'setes_setes', 1)).toBeNull()
  })

  it('lê pela COMPETÊNCIA da ordem, com o schema e a institution do escopo', async () => {
    mockQuery.mockResolvedValueOnce(agregado())
    await contractBillingReference(7953, 'setes_setes', 7)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(String(sql)).toMatch(/tb_contract_item_competence/)
    expect(String(sql)).toMatch(/`setes_setes`/)
    expect(String(sql)).not.toMatch(/undefined/)
    expect(params).toEqual([7, 7953])
  })
})

describe('contractPaymentDay (atalho da sugestão da tela)', () => {
  it('devolve só o dia', async () => {
    mockQuery.mockResolvedValueOnce(agregado())
    expect(await contractPaymentDay(7953, 'setes_setes', 1)).toBe(10)
  })
  it('dia divergente → null (a sugestão volta a ser a genérica)', async () => {
    mockQuery.mockResolvedValueOnce(agregado({ dias: 3 }))
    expect(await contractPaymentDay(7953, 'setes_setes', 1)).toBeNull()
  })
})
