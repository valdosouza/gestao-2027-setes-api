/// <reference types="jest" />
// Onda 2 — composição @shared/bank-slip-registration. O que se fixa: a ORQUESTRAÇÃO
// (reserva sob lock → banco FORA da transação → S/F), a voz do banco idempotente,
// a única porta de efeitos (RECEBIDO → L source A; CANCELADO/EXPIRADO → C;
// MARCADO_RECEBIDO/ATRASADO/PROTESTO → só fato), efeito recusado = fato gravado +
// pendência, e cancelamento banco PRIMEIRO fail-closed. Peças reais são mockadas
// na fronteira (repositório da apresentação, peça do boleto, canal).
import pool from '../shared/db/connection'
import * as repo from '../shared/bank-slip-registration/registration.repository'
import * as slipPiece from '../shared/bank-slip'
import * as channel from '../shared/bank-channel'
import * as entity from '../shared/entity'
import {
  registerBankSlip, refreshRegistration, cancelRegisteredBankSlip, handleWebhookItems, kindForBankStatus, toDbDateTime,
} from '../shared/bank-slip-registration/bank-slip-registration'
import { HttpError } from '../shared/errors/http-error'
import { BankHttpError } from '../shared/bank-channel/https-json'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/db/savepoint', () => ({
  __esModule: true,
  runIsolated: async (_c: any, _n: any, _l: any, fn: any) => { try { return await fn() } catch { return null } },
}))
jest.mock('../shared/bank-slip-registration/registration.repository', () => {
  const actual = jest.requireActual('../shared/bank-slip-registration/registration.repository')
  return {
    __esModule: true, ...actual,
    latestRegistration: jest.fn(), insertRegistration: jest.fn(), setRequestCode: jest.fn(), fillBankData: jest.fn(),
    insertRegistrationEvent: jest.fn(), setRegistrationEventEffect: jest.fn(), findRegistrationByRequestCode: jest.fn(),
    listLiveRegistrationsToRefresh: jest.fn(), listInFlightRegistrations: jest.fn(),
  }
})
jest.mock('../shared/bank-slip', () => {
  const actual = jest.requireActual('../shared/bank-slip')
  return { __esModule: true, ...actual, lockSlip: jest.fn(), settleBankSlip: jest.fn(), cancelBankSlip: jest.fn() }
})
jest.mock('../shared/bank-channel', () => {
  const actual = jest.requireActual('../shared/bank-channel')
  return { __esModule: true, ...actual, openBankChannel: jest.fn() }
})
jest.mock('../shared/entity', () => ({ __esModule: true, getEntityFiscalFull: jest.fn() }))

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)

const adapter = {
  bankNumber: '077', register: jest.fn(), query: jest.fn(), cancel: jest.fn(), pdf: jest.fn(),
  findByReference: jest.fn(), webhookGet: jest.fn(), webhookPut: jest.fn(), webhookDelete: jest.fn(), paySandbox: jest.fn(),
}
const opened = { channel: { bankAccountId: 3, institutionId: 1, environment: 'S', clientId: 'c', inboundToken: 't', active: 'S', bankNumber: '077', accountNumber: '1', accountNumberDv: '2' }, adapter, ctx: {} }

const header = { id: 262, bankAccountId: 3, ourNumber: '262', value: 250, dtExpiration: '2026-10-10', aliqInterest: null, aliqFine: null, aliqDiscount: null, dtDiscountUntil: null, instruction: null }
const lockedOpen = { id: 262, bankAccountId: 3, ourNumber: '262', value: 250, discountValue: 0, aliqDiscount: 0, dtDiscountUntil: null, lastKind: 'E', lastEvent: 1, lastSettledCode: null }
const regLive = (over: any = {}) => ({
  institutionId: 1, slipId: 262, attempt: 1, environment: 'S', requestCode: 'uuid-1', bankOurNumber: null, digitableLine: null, barcode: null,
  pixCopyPaste: null, pixTxid: null, createdAt: '2026-09-19 10:00:00', lastEvent: 1, lastKind: 'S', lastBankStatus: 'EM_PROCESSAMENTO', lastDtBankStatus: null, lastEventAt: '2026-09-19 10:00:00', ...over,
})
const S = { schema: 'setes_setes', inst: 1, user: 7 }

/** pool.query padrão: cabeçalho do boleto, depois cliente do título, depois UF. */
function poolDefaults() {
  q.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_bank_slip WHERE/.test(sql)) return [[header]]
    if (/tb_bank_slip_title t/.test(sql)) return [[{ entityId: 900 }]]
    if (/tb_state/.test(sql)) return [[{ abbreviation: 'PR' }]]
    return [[]]
  })
}
const fullEntity = () => ({
  id: 900, entity: { nameCompany: 'Cliente Ltda', nickTrade: null }, personType: 'J', person: null, company: { cnpj: '12.345.678/0001-99' }, noDoc: null,
  addresses: [{ kind: 'C', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.000-000', tbCountryId: 1, tbStateId: 16, tbCityId: 1, main: 'S', countryName: 'Brasil', stateName: 'Paraná', cityName: 'Curitiba' }],
  phones: [], socialMedia: [],
})

beforeEach(() => {
  jest.clearAllMocks()
  conn.query.mockResolvedValue([{}])
  poolDefaults()
  ;(entity.getEntityFiscalFull as jest.Mock).mockResolvedValue(fullEntity())
  ;(channel.openBankChannel as jest.Mock).mockResolvedValue(opened)
  ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen })
  ;(repo.latestRegistration as jest.Mock).mockResolvedValue(null)
  ;(repo.insertRegistration as jest.Mock).mockResolvedValue(1)
  ;(repo.insertRegistrationEvent as jest.Mock).mockResolvedValue(1)
})

describe('registerBankSlip — apresentar ao banco', () => {
  it('caminho feliz: pagador da cadeia, reserva attempt 1 SOB lock, banco fora da transação, depois request_code + evento S (source P)', async () => {
    adapter.register.mockResolvedValue({ requestCode: 'uuid-1' })
    const r = await registerBankSlip(S.schema, S.inst, S.user, 262)
    expect(r).toEqual({ slipId: 262, attempt: 1, requestCode: 'uuid-1', environment: 'S' })
    // pagador montado da cadeia da entidade (dígitos, UF, CEP 8)
    expect(adapter.register.mock.calls[0][1]).toMatchObject({
      reference: '262', amount: 250, dueDate: '2026-10-10',
      payer: { document: '12345678000199', personType: 'J', name: 'Cliente Ltda', street: 'Rua A, 10', neighborhood: 'Centro', city: 'Curitiba', state: 'PR', zipCode: '80000000' },
    })
    // ordem: lock → reserva → (banco) → lock → código → S
    expect(slipPiece.lockSlip).toHaveBeenCalledTimes(2)
    expect(repo.insertRegistration).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 'S', S.user)
    expect(repo.setRequestCode).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, 'uuid-1')
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, S.user,
      expect.objectContaining({ kind: 'S', source: 'P', bankStatus: 'EM_PROCESSAMENTO' }))
    expect(conn.commit).toHaveBeenCalledTimes(2)
    // o banco NUNCA é chamado com uma transação aberta
    const bankCallIndex = adapter.register.mock.invocationCallOrder[0]
    expect(conn.commit.mock.invocationCallOrder[0]).toBeLessThan(bankCallIndex)
    expect(conn.beginTransaction.mock.invocationCallOrder[1]).toBeGreaterThan(bankCallIndex)
  })

  it('D-I17: cliente sem CEP válido → 422 BANK_PAYER_INCOMPLETE com o campo, ANTES de reservar e de chamar o banco', async () => {
    const e = fullEntity(); e.addresses[0].zipCode = '800'
    ;(entity.getEntityFiscalFull as jest.Mock).mockResolvedValue(e)
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({
      statusCode: 422, code: 'BANK_PAYER_INCOMPLETE', fields: [expect.objectContaining({ field: 'payer.zipCode' })],
    })
    expect(repo.insertRegistration).not.toHaveBeenCalled(); expect(adapter.register).not.toHaveBeenCalled()
  })

  it('apresentação VIGENTE → 409 BANK_SLIP_ALREADY_REGISTERED (sem chamar o banco)', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G', lastBankStatus: 'A_RECEBER' }))
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_ALREADY_REGISTERED' })
    expect(adapter.register).not.toHaveBeenCalled()
  })

  it('apresentação ENCERRADA (F) → nova tentativa attempt 2 (mesmo boleto, mesmo seuNumero — D16/D-I12)', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'F', requestCode: null }))
    ;(repo.insertRegistration as jest.Mock).mockResolvedValue(2)
    adapter.register.mockResolvedValue({ requestCode: 'uuid-2' })
    const r = await registerBankSlip(S.schema, S.inst, S.user, 262)
    expect(r.attempt).toBe(2)
    expect(adapter.register.mock.calls[0][1].reference).toBe('262')
  })

  it('reserva SEM evento há menos de 10 min = em andamento → 409 IN_PROGRESS; mais velha → vira F e segue', async () => {
    const recent = new Date(Date.now() - 2 * 60_000)
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: null, lastEvent: null, requestCode: null, createdAt: fmt(recent) }))
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ code: 'BANK_SLIP_REGISTRATION_IN_PROGRESS' })

    const old = new Date(Date.now() - 30 * 60_000)
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: null, lastEvent: null, requestCode: null, createdAt: fmt(old) }))
    ;(repo.insertRegistration as jest.Mock).mockResolvedValue(2)
    adapter.register.mockResolvedValue({ requestCode: 'uuid-2' })
    await registerBankSlip(S.schema, S.inst, S.user, 262)
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, S.user,
      expect.objectContaining({ kind: 'F', message: expect.stringMatching(/interrompido/) }))
  })

  it('banco RECUSA → tentativa grava F com a mensagem do banco e o erro do banco sobe (422)', async () => {
    adapter.register.mockRejectedValue(new BankHttpError(422, 'Banco recusou (400): pagador.cep: inválido', 'BANK_REJECTED', 400, '{}'))
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ statusCode: 422, code: 'BANK_REJECTED' })
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, S.user,
      expect.objectContaining({ kind: 'F', source: 'P', message: expect.stringMatching(/pagador\.cep/) }))
    expect(repo.setRequestCode).not.toHaveBeenCalled()
  })

  it('boleto não aberto → 409 BANK_SLIP_NOT_OPEN na reserva (banco nunca chamado)', async () => {
    ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen, lastKind: 'C' })
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ code: 'BANK_SLIP_NOT_OPEN' })
    expect(adapter.register).not.toHaveBeenCalled()
  })

  it('canal ausente → 409 BANK_CHANNEL_MISSING antes de reservar', async () => {
    ;(channel.openBankChannel as jest.Mock).mockRejectedValue(new HttpError(409, 'sem canal', undefined, 'BANK_CHANNEL_MISSING'))
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ code: 'BANK_CHANNEL_MISSING' })
    expect(repo.insertRegistration).not.toHaveBeenCalled()
  })
})

describe('refreshRegistration — a voz do banco', () => {
  const status = (over: any = {}) => ({
    requestCode: 'uuid-1', reference: '262', status: 'A_RECEBER', statusAt: '2026-09-19T12:00:00', amount: 250, paidValue: null, paidBy: null,
    bankOurNumber: '00012345678', digitableLine: '7'.repeat(47), barcode: '7'.repeat(44), pixCopyPaste: 'pix', pixTxid: 'TX', cancelReason: null, ...over,
  })

  it('A_RECEBER → evento G (source Q), write-once dos dados do banco, SEM efeito no boleto', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive())
    adapter.query.mockResolvedValue(status())
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'G', bankStatus: 'A_RECEBER', slipEvent: null, effectRefused: null })
    expect(repo.fillBankData).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1,
      expect.objectContaining({ digitableLine: '7'.repeat(47), pixCopyPaste: 'pix' }))
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, S.user,
      expect.objectContaining({ kind: 'G', bankStatus: 'A_RECEBER', dtBankStatus: '2026-09-19 12:00:00', source: 'Q' }))
    expect(slipPiece.settleBankSlip).not.toHaveBeenCalled(); expect(slipPiece.cancelBankSlip).not.toHaveBeenCalled()
    // consulta ao banco com o ambiente CONGELADO da apresentação
    expect((channel.openBankChannel as jest.Mock).mock.calls[0][3]).toMatchObject({ environment: 'S' })
  })

  it('IDEMPOTÊNCIA: mesma situação e mesma data → nenhum evento novo (o mesmo webhook 2× não baixa 2×)', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G', lastBankStatus: 'A_RECEBER', lastDtBankStatus: '2026-09-19 12:00:00' }))
    adapter.query.mockResolvedValue(status())
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'W')
    expect(r.changed).toBe(false)
    expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
  })

  it('RECEBIDO → evento R + LIQUIDAÇÃO pela peça (source A, valor e data do BANCO) e slip_event ligado (causa → efeito)', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    ;(repo.insertRegistrationEvent as jest.Mock).mockResolvedValue(2)
    ;(slipPiece.settleBankSlip as jest.Mock).mockResolvedValue({ settledCode: 900, statementId: 1, event: 2, titles: 1 })
    adapter.query.mockResolvedValue(status({ status: 'RECEBIDO', statusAt: '2026-09-21', paidValue: 250, paidBy: 'PIX' }))
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'W')
    expect(r).toMatchObject({ changed: true, kind: 'R', slipEvent: 2, effectRefused: null })
    expect(slipPiece.settleBankSlip).toHaveBeenCalledWith(conn, S.schema, S.inst, S.user,
      expect.objectContaining({ slipId: 262, paidValue: 250, dtPayment: '2026-09-21', source: 'A' }))
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, S.user,
      expect.objectContaining({ kind: 'R', paidValue: 250, paidBy: 'X', source: 'W' }))
    expect(repo.setRegistrationEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, 2, 2, null)
  })

  it('D-I10: RECEBIDO que a NOSSA regra recusa (abaixo do mínimo) → fato gravado, slip_event NULL, pendência legível — nunca baixa forçada', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    ;(repo.insertRegistrationEvent as jest.Mock).mockResolvedValue(2)
    ;(slipPiece.settleBankSlip as jest.Mock).mockRejectedValue(new HttpError(409, 'abaixo do mínimo', undefined, 'BANK_SLIP_BELOW_MINIMUM'))
    adapter.query.mockResolvedValue(status({ status: 'RECEBIDO', statusAt: '2026-09-21', paidValue: 90 }))
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'R', slipEvent: null, effectRefused: 'abaixo do mínimo' })
    expect(repo.setRegistrationEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, 2, null, 'Efeito recusado: abaixo do mínimo')
    expect(conn.commit).toHaveBeenCalled()      // o fato do banco FICOU
  })

  it('RECEBIDO com boleto JÁ liquidado (baixa manual antes do aviso) → link para o L existente, sem 2ª baixa', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen, lastKind: 'L', lastEvent: 5 })
    adapter.query.mockResolvedValue(status({ status: 'RECEBIDO', paidValue: 250 }))
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r.slipEvent).toBe(5)
    expect(slipPiece.settleBankSlip).not.toHaveBeenCalled()
  })

  it('CANCELADO e EXPIRADO no banco → C no boleto com source A; MARCADO_RECEBIDO, ATRASADO e PROTESTO → só fato', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    ;(slipPiece.cancelBankSlip as jest.Mock).mockResolvedValue(3)
    adapter.query.mockResolvedValue(status({ status: 'EXPIRADO', statusAt: '2026-12-10' }))
    let r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r).toMatchObject({ kind: 'V', slipEvent: 3 })
    expect(slipPiece.cancelBankSlip).toHaveBeenLastCalledWith(conn, S.schema, S.inst, S.user, 262, expect.stringMatching(/Expirado/), 'A')

    adapter.query.mockResolvedValue(status({ status: 'CANCELADO', statusAt: '2026-12-11', cancelReason: 'portal' }))
    r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r.kind).toBe('C')
    expect(slipPiece.cancelBankSlip).toHaveBeenLastCalledWith(conn, S.schema, S.inst, S.user, 262, expect.stringMatching(/portal/), 'A')

    for (const [st, kind] of [['MARCADO_RECEBIDO', 'M'], ['ATRASADO', 'A'], ['PROTESTO', 'P']] as const) {
      jest.clearAllMocks(); poolDefaults()
      ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
      ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen })
      ;(channel.openBankChannel as jest.Mock).mockResolvedValue(opened)
      adapter.query.mockResolvedValue(status({ status: st, statusAt: '2026-12-12' }))
      r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
      expect(r).toMatchObject({ kind, slipEvent: null, effectRefused: null })
      expect(slipPiece.settleBankSlip).not.toHaveBeenCalled(); expect(slipPiece.cancelBankSlip).not.toHaveBeenCalled()
    }
  })

  it('situação DESCONHECIDA → BANK_STATUS_UNKNOWN antes de gravar (o contrato mudou — alguém precisa olhar)', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive())
    adapter.query.mockResolvedValue(status({ status: 'NOVIDADE' }))
    await expect(refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')).rejects.toMatchObject({ code: 'BANK_STATUS_UNKNOWN' })
    expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
    expect(() => kindForBankStatus('X')).toThrow()
  })

  it('nunca apresentado → 409 BANK_SLIP_NOT_REGISTERED; em andamento (sem código) → nada a consultar', async () => {
    await expect(refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')).rejects.toMatchObject({ code: 'BANK_SLIP_NOT_REGISTERED' })
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ requestCode: null, lastKind: null }))
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r.changed).toBe(false); expect(adapter.query).not.toHaveBeenCalled()
  })

  it('toDbDateTime aceita date e date-time do banco', () => {
    expect(toDbDateTime('2026-09-21')).toBe('2026-09-21 00:00:00')
    expect(toDbDateTime('2026-09-21T13:45:10-03:00')).toBe('2026-09-21 13:45:10')
    expect(toDbDateTime(null)).toBeNull()
  })
})

describe('cancelRegisteredBankSlip — banco primeiro, fail-closed (D-I8)', () => {
  it('com apresentação vigente: cancel no banco ANTES; aceito → C no boleto (source M) + evento K ligado', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    adapter.cancel.mockResolvedValue(undefined)
    ;(slipPiece.cancelBankSlip as jest.Mock).mockResolvedValue(4)
    const r = await cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, 'cliente desistiu')
    expect(r).toEqual({ slipEvent: 4, bankNotified: true, attempt: 1 })
    expect(adapter.cancel).toHaveBeenCalledWith(opened.ctx, 'uuid-1', 'cliente desistiu')
    expect(adapter.cancel.mock.invocationCallOrder[0]).toBeLessThan(conn.beginTransaction.mock.invocationCallOrder[0])
    expect(slipPiece.cancelBankSlip).toHaveBeenCalledWith(conn, S.schema, S.inst, S.user, 262, 'cliente desistiu', 'M')
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, S.user,
      expect.objectContaining({ kind: 'K', source: 'P', slipEvent: 4 }))
  })

  it('banco INDISPONÍVEL → 503 e NADA muda aqui (sem C, sem K)', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    adapter.cancel.mockRejectedValue(new BankHttpError(503, 'fora', 'BANK_UNAVAILABLE', 0, ''))
    await expect(cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, null)).rejects.toMatchObject({ code: 'BANK_UNAVAILABLE' })
    expect(slipPiece.cancelBankSlip).not.toHaveBeenCalled(); expect(conn.beginTransaction).not.toHaveBeenCalled()
  })

  it('sem apresentação (nunca enviado ou já encerrada) → cancelamento local de sempre, banco não é chamado', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'F', requestCode: null }))
    ;(slipPiece.cancelBankSlip as jest.Mock).mockResolvedValue(2)
    const r = await cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, null)
    expect(r).toEqual({ slipEvent: 2, bankNotified: false, attempt: null })
    expect(adapter.cancel).not.toHaveBeenCalled()
  })
})

describe('handleWebhookItems — gatilho, nunca verdade (D-I9)', () => {
  it('cada codigoSolicitacao conhecido dispara a CONSULTA (source W); desconhecidos são listados, nada é gravado pelo payload', async () => {
    ;(repo.findRegistrationByRequestCode as jest.Mock).mockImplementation(async (_s: string, _i: number, code: string) =>
      code === 'uuid-1' ? regLive({ lastKind: 'G' }) : null)
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    adapter.query.mockResolvedValue({ requestCode: 'uuid-1', reference: '262', status: 'A_RECEBER', statusAt: '2026-09-19T12:00:00', amount: 250, paidValue: null, paidBy: null, bankOurNumber: null, digitableLine: null, barcode: null, pixCopyPaste: null, pixTxid: null, cancelReason: null })
    const r = await handleWebhookItems(S.schema, S.inst, ['uuid-1', 'forjado', 'uuid-1'])
    expect(r).toEqual({ received: 3, matched: 1, changed: 1, unknown: ['forjado'] })
    expect(adapter.query).toHaveBeenCalledTimes(1)
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, null, expect.objectContaining({ source: 'W' }))
  })
})
