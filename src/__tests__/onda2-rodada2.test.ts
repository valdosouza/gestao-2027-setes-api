/// <reference types="jest" />
// Onda 2 Banco Inter — RODADA 2 de decisões (Valdo 2026-09-21, "siga as recomendações"):
//   D-I25 (Q-I1)  reaplicação MANUAL do efeito recusado = evento próprio 'E', final como a voz
//   D-I26 (Q-I8)  DELETE do canal: recusa com apresentação viva; sem viva apaga segredos S+P e o
//                 revive nasce com token NOVO
//   D-I27 (Q-I11) PUT do canal não muda o ambiente com apresentação viva no ambiente atual
//   D-I28 (Q-I5)  lista de boletos carrega `pendingBankEffects` e o filtro `pending=true`
// Peças reais são mockadas na fronteira (repositório da apresentação, peça do boleto, cofre).
import pool from '../shared/db/connection'
import * as repo from '../shared/bank-slip-registration/registration.repository'
import * as slipPiece from '../shared/bank-slip'
import * as secretStore from '../shared/secret-store'
import * as channelRepo from '../shared/bank-channel/bank-channel.repository'
import { reapplyRegistrationEffect, registerBankSlip } from '../shared/bank-slip-registration/bank-slip-registration'
import * as entity from '../shared/entity'
import { removeChannel, saveChannel } from '../modules/bank-accounts/bank-accounts.channel.service'
import * as accountsRepo from '../modules/bank-accounts/bank-accounts.repository'
import { parsePendingOnly } from '../modules/bank-slips/bank-slips.service'
import { listBankSlips } from '../modules/bank-slips/bank-slips.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/bank-slip-registration/registration.repository', () => {
  const actual = jest.requireActual('../shared/bank-slip-registration/registration.repository')
  return {
    __esModule: true, ...actual,
    getRegistration: jest.fn(), getRegistrationEvent: jest.fn(), insertRegistrationEvent: jest.fn(),
    setRegistrationEventEffect: jest.fn(), countLiveRegistrationsForAccount: jest.fn(), countPendingEffects: jest.fn(),
    insertRegistration: jest.fn(),
  }
})
jest.mock('../shared/entity', () => ({ __esModule: true, ...jest.requireActual('../shared/entity'), getEntityFiscalFull: jest.fn() }))
jest.mock('../shared/bank-slip', () => {
  const actual = jest.requireActual('../shared/bank-slip')
  return { __esModule: true, ...actual, lockSlip: jest.fn(), settleBankSlip: jest.fn(), cancelBankSlip: jest.fn() }
})
jest.mock('../shared/secret-store', () => {
  const actual = jest.requireActual('../shared/secret-store')
  return { __esModule: true, ...actual, deleteSecret: jest.fn() }
})
jest.mock('../shared/bank-channel/bank-channel.repository', () => {
  const actual = jest.requireActual('../shared/bank-channel/bank-channel.repository')
  return { __esModule: true, ...actual, getBankChannel: jest.fn(), softDeleteBankChannel: jest.fn(), upsertBankChannel: jest.fn() }
})
jest.mock('../modules/bank-accounts/bank-accounts.repository', () => ({ __esModule: true, getBankAccount: jest.fn() }))

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)

const S = { schema: 'setes_setes', inst: 1, user: 7 }
const lockedOpen = { id: 262, bankAccountId: 3, ourNumber: '262', value: 250, discountValue: 0, aliqDiscount: 0, dtDiscountUntil: null, lastKind: 'E', lastEvent: 1, lastSettledCode: null }
const reg = (over: any = {}) => ({
  institutionId: 1, slipId: 262, attempt: 1, environment: 'S', requestCode: 'uuid-1', bankOurNumber: null, digitableLine: null, barcode: null,
  pixCopyPaste: null, pixTxid: null, createdAt: '2026-09-19 10:00:00', lastQueriedAt: null, lastEvent: 2, lastKind: 'R', lastBankStatus: 'RECEBIDO',
  lastDtBankStatus: '2026-09-20 09:00:00', lastEventAt: '2026-09-20 09:05:00', ...over,
})
const refusedR = (over: any = {}) => ({
  attempt: 1, event: 2, kind: 'R', bankStatus: 'RECEBIDO', dtBankStatus: '2026-09-20 09:00:00', source: 'W',
  paidValue: 250, paidBy: 'X', slipEvent: null, message: 'Efeito recusado: caixa fechado', userId: null, createdAt: '2026-09-20 09:05:00', ...over,
})
const channel = (over: any = {}) => ({
  bankAccountId: 5, institutionId: 1, environment: 'S', clientId: 'cid', inboundToken: 'tok', active: 'S', bankNumber: '077', accountNumber: '1', accountNumberDv: null, ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  conn.query.mockResolvedValue([{}])
  q.mockResolvedValue([[]])
  ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen })
  ;(repo.getRegistration as jest.Mock).mockResolvedValue(reg())
  ;(repo.getRegistrationEvent as jest.Mock).mockResolvedValue(refusedR())
  ;(repo.insertRegistrationEvent as jest.Mock).mockResolvedValue(3)
  ;(repo.countLiveRegistrationsForAccount as jest.Mock).mockResolvedValue(0)
  ;(repo.countPendingEffects as jest.Mock).mockResolvedValue(0)
  ;(channelRepo.getBankChannel as jest.Mock).mockResolvedValue(channel())
  ;(channelRepo.softDeleteBankChannel as jest.Mock).mockResolvedValue(true)
  ;(channelRepo.upsertBankChannel as jest.Mock).mockResolvedValue(channel())
  ;(accountsRepo.getBankAccount as jest.Mock).mockResolvedValue({ id: 5, bankNumber: '077' })
})

describe('D-I25 — reaplicar o efeito recusado é ato MANUAL com evento próprio E', () => {
  it('R recusado → mesma porta de efeitos com a voz GRAVADA (valor/data/meio do evento), E com slip_event, original deixa de ser pendência', async () => {
    ;(slipPiece.settleBankSlip as jest.Mock).mockResolvedValue({ event: 9, settledCode: 77 })
    const r = await reapplyRegistrationEffect(S.schema, S.inst, S.user, 262, 1, 2)
    expect(r).toEqual({ slipId: 262, attempt: 1, event: 2, reapplyEvent: 3, slipEvent: 9 })
    // lock do boleto ANTES de ler o evento (FOR UPDATE nos dois)
    expect(slipPiece.lockSlip).toHaveBeenCalledTimes(1)
    expect(repo.getRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, 2, true)
    // a baixa nasce do FATO gravado, não de nova consulta — source A, valor e data do banco
    expect(slipPiece.settleBankSlip).toHaveBeenCalledWith(conn, S.schema, S.inst, S.user,
      expect.objectContaining({ slipId: 262, paidValue: 250, dtPayment: '2026-09-20', source: 'A' }))
    // o ATO: evento E, source P, aponta para o efeito
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, S.user,
      expect.objectContaining({ kind: 'E', source: 'P', slipEvent: 9, bankStatus: 'RECEBIDO' }))
    // o R original recebe o mesmo slip_event → some da lista de pendências
    expect(repo.setRegistrationEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, 2, 9, 'Efeito reaplicado (evento 3)')
    expect(conn.commit).toHaveBeenCalledTimes(1); expect(conn.rollback).not.toHaveBeenCalled()
  })

  it('C recusado → cancelBankSlip source A com a nota do banco', async () => {
    ;(repo.getRegistrationEvent as jest.Mock).mockResolvedValue(refusedR({ kind: 'C', bankStatus: 'CANCELADO', paidValue: null, paidBy: null }))
    ;(slipPiece.cancelBankSlip as jest.Mock).mockResolvedValue(11)
    const r = await reapplyRegistrationEffect(S.schema, S.inst, S.user, 262, 1, 2)
    expect(r.slipEvent).toBe(11)
    expect(slipPiece.cancelBankSlip).toHaveBeenCalledWith(conn, S.schema, S.inst, S.user, 262, expect.stringContaining('Cancelado no banco'), 'A')
    expect(slipPiece.settleBankSlip).not.toHaveBeenCalled()
  })

  it('a regra recusa DE NOVO (caixa fechado) → 409 com o motivo, NADA gravado, transação desfeita', async () => {
    const { HttpError } = jest.requireActual('../shared/errors/http-error')
    ;(slipPiece.settleBankSlip as jest.Mock).mockRejectedValue(new HttpError(409, 'Caixa fechado', undefined, 'CASHIER_CLOSED'))
    await expect(reapplyRegistrationEffect(S.schema, S.inst, S.user, 262, 1, 2)).rejects.toMatchObject({ statusCode: 409, code: 'CASHIER_CLOSED' })
    expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
    expect(repo.setRegistrationEventEffect).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalledTimes(1); expect(conn.commit).not.toHaveBeenCalled()
  })

  it('boleto já liquidado por outro caminho → link ao evento existente (sem 2ª baixa), E gravado', async () => {
    ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen, lastKind: 'L', lastEvent: 4 })
    const r = await reapplyRegistrationEffect(S.schema, S.inst, S.user, 262, 1, 2)
    expect(r.slipEvent).toBe(4)
    expect(slipPiece.settleBankSlip).not.toHaveBeenCalled()
    expect(repo.setRegistrationEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, 2, 4, expect.any(String))
  })

  it('evento sem efeito (G) ou já aplicado → 409 BANK_SLIP_EFFECT_NOT_PENDING; inexistente → 404', async () => {
    ;(repo.getRegistrationEvent as jest.Mock).mockResolvedValueOnce(refusedR({ kind: 'G', bankStatus: 'A_RECEBER' }))
    await expect(reapplyRegistrationEffect(S.schema, S.inst, S.user, 262, 1, 2)).rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_EFFECT_NOT_PENDING' })
    ;(repo.getRegistrationEvent as jest.Mock).mockResolvedValueOnce(refusedR({ slipEvent: 9 }))
    await expect(reapplyRegistrationEffect(S.schema, S.inst, S.user, 262, 1, 2)).rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_EFFECT_NOT_PENDING' })
    ;(repo.getRegistrationEvent as jest.Mock).mockResolvedValueOnce(null)
    await expect(reapplyRegistrationEffect(S.schema, S.inst, S.user, 262, 1, 99)).rejects.toMatchObject({ statusCode: 404, code: 'BANK_SLIP_REGISTRATION_EVENT_NOT_FOUND' })
    ;(repo.getRegistration as jest.Mock).mockResolvedValueOnce(null)
    await expect(reapplyRegistrationEffect(S.schema, S.inst, S.user, 262, 9, 2)).rejects.toMatchObject({ statusCode: 404 })
    expect(slipPiece.settleBankSlip).not.toHaveBeenCalled(); expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
  })

  it('socrático R2: boleto com efeito PENDENTE não aceita nova apresentação (409 BANK_SLIP_EFFECT_PENDING) — antes do pagador, do canal e da reserva', async () => {
    q.mockImplementation(async (sql: string) => /tb_bank_slip WHERE/.test(sql)
      ? [[{ id: 262, bankAccountId: 3, ourNumber: '262', value: 250, dtExpiration: '2026-10-10' }]] : [[]])
    ;(repo.countPendingEffects as jest.Mock).mockResolvedValue(1)
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_EFFECT_PENDING' })
    expect(entity.getEntityFiscalFull).not.toHaveBeenCalled()
    expect(repo.insertRegistration).not.toHaveBeenCalled()
    expect(conn.beginTransaction).not.toHaveBeenCalled()
  })

  it('smoke do sandbox: vencimento anterior a hoje → 422 BANK_SLIP_EXPIRATION_PAST no campo, antes do pagador/canal/reserva', async () => {
    q.mockImplementation(async (sql: string) => /tb_bank_slip WHERE/.test(sql)
      ? [[{ id: 262, bankAccountId: 3, ourNumber: '262', value: 250, dtExpiration: '2018-07-31' }]] : [[]])
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({
      statusCode: 422, code: 'BANK_SLIP_EXPIRATION_PAST', fields: [expect.objectContaining({ field: 'dtExpiration' })],
    })
    expect(entity.getEntityFiscalFull).not.toHaveBeenCalled()
    expect(repo.insertRegistration).not.toHaveBeenCalled()
  })

  it('E é FINAL (encerra como a voz que reaplica): apresentação com último evento E não é vigente nem entra na consulta ativa', () => {
    const actual = jest.requireActual('../shared/bank-slip-registration/registration.repository')
    expect(actual.FINAL_REGISTRATION_KINDS.has('E')).toBe(true)
    expect(actual.isLive(reg({ lastKind: 'E' }))).toBe(false)
    expect(actual.EFFECT_KINDS.has('E')).toBe(false)     // E nunca é pendência
    expect(actual.PENDING_EFFECT_WHERE).toContain("kind IN ('R','C','V')")
  })
})

describe('D-I26 — DELETE do canal', () => {
  const scope = { schemaName: S.schema, institutionId: S.inst }

  it('apresentação VIVA no banco → 409 BANK_CHANNEL_HAS_LIVE_REGISTRATIONS, canal e segredos intactos', async () => {
    ;(repo.countLiveRegistrationsForAccount as jest.Mock).mockResolvedValue(2)
    await expect(removeChannel(5, scope)).rejects.toMatchObject({ statusCode: 409, code: 'BANK_CHANNEL_HAS_LIVE_REGISTRATIONS' })
    expect(channelRepo.softDeleteBankChannel).not.toHaveBeenCalled()
    expect(secretStore.deleteSecret).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('sem viva → soft delete SOB lock do canal + segredos dos DOIS ambientes fora do cofre', async () => {
    await removeChannel(5, scope)
    expect(channelRepo.getBankChannel).toHaveBeenCalledWith(conn, S.schema, S.inst, 5, true)
    // conta sem filtro de ambiente: qualquer apresentação viva prende o canal
    expect(repo.countLiveRegistrationsForAccount).toHaveBeenCalledWith(conn, S.schema, S.inst, 5)
    expect(channelRepo.softDeleteBankChannel).toHaveBeenCalledWith(conn, S.schema, S.inst, 5)
    expect(conn.commit).toHaveBeenCalledTimes(1)
    const refs = (secretStore.deleteSecret as jest.Mock).mock.calls.map(c => `${c[0].environment}/${c[0].name}`).sort()
    expect(refs).toEqual(['P/client.crt', 'P/client.key', 'P/client_secret', 'S/client.crt', 'S/client.key', 'S/client_secret'])
    // os segredos saem DEPOIS do commit (nunca antes — se o DELETE falhar o cofre fica)
    expect((secretStore.deleteSecret as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(conn.commit.mock.invocationCallOrder[0])
  })

  it('canal inexistente → 404 sem tocar o cofre', async () => {
    ;(channelRepo.getBankChannel as jest.Mock).mockResolvedValue(null)
    await expect(removeChannel(5, scope)).rejects.toMatchObject({ statusCode: 404, code: 'BANK_CHANNEL_MISSING' })
    expect(secretStore.deleteSecret).not.toHaveBeenCalled()
  })

  it('revive: o UPSERT do repositório troca o inbound_token só quando a linha estava excluída', async () => {
    const actual = jest.requireActual('../shared/bank-channel/bank-channel.repository')
    conn.query.mockImplementation(async (sql: string) => {
      if (/SELECT 1 FROM/.test(sql)) return [[{ 1: 1 }]]
      if (/INSERT INTO/.test(sql)) return [{}]
      return [[{ bankAccountId: 5, institutionId: 1, environment: 'S', clientId: 'c', inboundToken: 'novo', active: 'S', bankNumber: '077', accountNumber: '1', accountNumberDv: null }]]
    })
    await actual.upsertBankChannel(conn, S.schema, S.inst, 5, { environment: 'S', clientId: 'c', active: 'S' })
    const insert = conn.query.mock.calls.find(c => /INSERT INTO/.test(c[0]))!
    expect(insert[0].replace(/\s+/g, ' ')).toContain("inbound_token = IF(deleted = 'S', VALUES(inbound_token), inbound_token)")
    // a troca do token vem ANTES de deleted = 'N' (ON DUPLICATE KEY avalia da esquerda para a direita)
    expect(insert[0].indexOf('inbound_token = IF')).toBeLessThan(insert[0].indexOf("deleted = 'N', updated_at"))
  })
})

describe('D-I27 — PUT do canal não vira o ambiente com apresentação viva', () => {
  const scope = { schemaName: S.schema, institutionId: S.inst }
  const input = (environment: 'S' | 'P') => ({ environment, clientId: 'cid', active: 'S' as const })

  it('S → P com apresentações S vivas → 409 no campo environment, sem upsert', async () => {
    ;(repo.countLiveRegistrationsForAccount as jest.Mock).mockResolvedValue(3)
    await expect(saveChannel(5, input('P'), scope)).rejects.toMatchObject({
      statusCode: 409, code: 'BANK_CHANNEL_HAS_LIVE_REGISTRATIONS', fields: [expect.objectContaining({ field: 'environment' })],
    })
    // conta filtrada pelo ambiente ATUAL do canal (S), sob o lock do canal
    expect(repo.countLiveRegistrationsForAccount).toHaveBeenCalledWith(conn, S.schema, S.inst, 5, 'S')
    expect(channelRepo.upsertBankChannel).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('S → P sem viva → salva; mesmo ambiente (S → S) nem conta', async () => {
    await saveChannel(5, input('P'), scope)
    expect(channelRepo.upsertBankChannel).toHaveBeenCalledWith(conn, S.schema, S.inst, 5, expect.objectContaining({ environment: 'P' }))
    jest.clearAllMocks()
    ;(channelRepo.getBankChannel as jest.Mock).mockResolvedValue(channel())
    ;(accountsRepo.getBankAccount as jest.Mock).mockResolvedValue({ id: 5, bankNumber: '077' })
    await saveChannel(5, input('S'), scope)
    expect(repo.countLiveRegistrationsForAccount).not.toHaveBeenCalled()
    expect(channelRepo.upsertBankChannel).toHaveBeenCalled()
  })

  it('canal NOVO (sem linha) não conta nada', async () => {
    ;(channelRepo.getBankChannel as jest.Mock).mockResolvedValueOnce(null).mockResolvedValue(channel())
    await saveChannel(5, input('P'), scope)
    expect(repo.countLiveRegistrationsForAccount).not.toHaveBeenCalled()
  })
})

describe('D-I28 — pendência da voz do banco na LISTA de boletos', () => {
  it('parsePendingOnly aceita true/1/false/0/vazio e recusa o resto (400)', () => {
    expect(parsePendingOnly(undefined)).toBe(false); expect(parsePendingOnly('')).toBe(false)
    expect(parsePendingOnly('false')).toBe(false); expect(parsePendingOnly('0')).toBe(false)
    expect(parsePendingOnly('true')).toBe(true); expect(parsePendingOnly('1')).toBe(true)
    expect(() => parsePendingOnly('sim')).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it('a lista carrega pendingBankEffects pela regra da PEÇA e o filtro entra no HAVING (lista E contagem)', async () => {
    q.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await listBankSlips('open', { filter: '', page: 1, pageSize: 25, offset: 0 } as any, S.schema, S.inst, { pendingOnly: true })
    const [listSql, listParams] = q.mock.calls[0]
    const [countSql, countParams] = q.mock.calls[1]
    for (const sql of [listSql, countSql]) {
      expect(sql).toContain('AS pendingBankEffects')
      expect(sql).toContain("re.kind IN ('R','C','V') AND re.slip_event IS NULL")
      expect(sql.replace(/\s+/g, ' ')).toContain('HAVING state = ? AND pendingBankEffects > 0')
    }
    expect(listParams.slice(0, 5)).toEqual([S.inst, null, null, null, 'open'])
    expect(countParams).toEqual([S.inst, null, null, null, 'open'])
  })

  it('sem o filtro, o HAVING fica só com o estado (comportamento anterior preservado)', async () => {
    q.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await listBankSlips('', { filter: '', page: 1, pageSize: 25, offset: 0 } as any, S.schema, S.inst)
    expect(q.mock.calls[0][0]).not.toContain('HAVING')
    expect(q.mock.calls[0][0]).toContain('AS pendingBankEffects')
  })
})
