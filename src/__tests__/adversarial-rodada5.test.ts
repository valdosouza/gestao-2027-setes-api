/// <reference types="jest" />
// Gate adversarial da Rodada 5 (Primeiro Cliente — D23–D29), 2026-09-19.
// Achado PROVADO ao vivo no dev (OS 7989, contrato 51):
//
//   Com a D23 as condições ficam CONGELADAS por competência. UM contrato editado
//   entre dois meses NÃO faturados deixa dois fatos DIVERGENTES na MESMA OS
//   (2026-07 → dia 5/forma 1; 2026-08 → dia 6/forma 2). O lote recusa a ordem com
//   "Ordem sem dia de vencimento de contrato — informe o vencimento do lote ou
//   ACERTE O CONTRATO DO CLIENTE" — e acertar o contrato NÃO resolve mais (o fato
//   é imutável por decisão; provado: PUT de volta para 5/1 e a ordem continuou
//   recusada). A única saída real é o override no lote (as DUAS condições) ou
//   cancelar a OS e reinjetar os meses. A mensagem manda o operador para um beco.
//
// O que este teste fixa: quando a divergência vem dos FATOS da própria ordem
// (agregado com `dias > 1` ou `formas > 1`), a linha recusada tem que apontar a
// saída que EXISTE e não pode mandar acertar o contrato. A OS avulsa (sem
// competência nenhuma) continua com a mensagem de hoje — o teste separa os dois
// casos para a correção não nivelar tudo por baixo.
//
// Vermelho de propósito até a correção — CORRIGIDO em sessão (2026-09-19): mensagens
// distintas para OS avulsa × fatos divergentes (`ORDER_STANDALONE_*_MSG` ×
// `ORDER_NO_CONTRACT_*_MSG`), nas duas portas (fora e dentro da transação — M1).
import pool from '../shared/db/connection'
import { invoiceOrderBatch } from '../modules/service-orders/service-orders.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
// só o faturamento em si é substituído — orderExists e contractBillingReference
// são os REAIS, alimentados pelas linhas que o banco devolveria
jest.mock('../modules/service-orders/service-orders.repository', () => {
  const real = jest.requireActual('../modules/service-orders/service-orders.repository')
  return { __esModule: true, ...real, generateInvoice: jest.fn() }
})

const mockQuery = (pool as any).query as jest.Mock
const scope = { schemaName: 'setes_setes', institutionId: 1, userId: 1 }

/** Agregado de tb_contract_item_competence da ordem (a forma do SELECT do repositório). */
const agregado = (over: Record<string, any> = {}) => [[{
  competence: '2026-08', dias: 1, paymentDay: 5,
  contratos: 2, formas: 1, comForma: 2, paymentTypeId: 1, ...over,
}]]

beforeEach(() => jest.clearAllMocks())

describe('Achado adversarial R5 — fatos congelados DIVERGENTES na mesma OS (efeito da D23)', () => {
  it('dias divergem entre competências da MESMA ordem → a recusa não pode mandar "acertar o contrato" (não resolve mais) e tem que apontar a saída real', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ 1: 1 }]])                       // orderExists
      .mockResolvedValueOnce(agregado({ dias: 2, paymentDay: 5 })) // 2026-07 dia 5 × 2026-08 dia 6

    const r = await invoiceOrderBatch({ orderIds: [7989], parcels: 1 } as any, scope)

    expect(r.results[0].ok).toBe(false)
    expect(r.results[0].error).not.toMatch(/acerte o contrato|combine a forma no contrato/i)
    // a saída que existe: informar as condições no lote OU cancelar a OS e reinjetar
    expect(r.results[0].error).toMatch(/lote/i)
    expect(r.results[0].error).toMatch(/cancel|reinjet|compet/i)
  })

  it('formas divergem (só a data foi informada no lote) → mesma regra para a forma', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce(agregado({ formas: 2, comForma: 2, paymentTypeId: 1 }))

    const r = await invoiceOrderBatch({ orderIds: [7989], parcels: 1, dtExpiration: '2026-10-05' } as any, scope)

    expect(r.results[0].ok).toBe(false)
    expect(r.results[0].error).not.toMatch(/acerte o contrato|combine a forma no contrato/i)
    expect(r.results[0].error).toMatch(/lote/i)
  })

  it('OS AVULSA (sem competência nenhuma) continua com a mensagem de hoje — aqui "acertar o contrato" faz sentido', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ competence: null }]])              // MAX() de zero linhas

    const r = await invoiceOrderBatch({ orderIds: [7980], parcels: 1 } as any, scope)

    expect(r.results[0]).toMatchObject({ ok: false, code: 'ORDER_NO_CONTRACT_DUE_DAY' })
    expect(r.results[0].error).toMatch(/informe o vencimento do lote/)
  })
})
