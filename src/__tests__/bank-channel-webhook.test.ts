/// <reference types="jest" />
// Onda 2 — rota PÚBLICA do webhook (/hooks/bank-channel/:institutionId/:token).
// O que se fixa: sem JWT; token desconhecido/institution inválida/canal inativo
// → 404 sem distinguir; token certo → 200 imediato e o processamento recebe SÓ os
// codigoSolicitacao (o payload nunca é verdade); corpo forjado sem códigos → nada.
import request from 'supertest'
import app from '../app'
import pool from '../shared/db/connection'
import * as channel from '../shared/bank-channel'
import { setWebhookProcessor, extractRequestCodes } from '../modules/bank-channel-webhook/bank-channel-webhook.routes'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/bank-channel', () => {
  const actual = jest.requireActual('../shared/bank-channel')
  return { __esModule: true, ...actual, findBankChannelByInboundToken: jest.fn() }
})
const q = (pool as any).query as jest.Mock
const findChannel = channel.findBankChannelByInboundToken as jest.Mock
const TOKEN = 'a'.repeat(48)
const liveChannel = { bankAccountId: 3, institutionId: 1, environment: 'S', clientId: 'c', inboundToken: TOKEN, active: 'S', bankNumber: '077', accountNumber: '1', accountNumberDv: null }

const processed: any[] = []
beforeAll(() => setWebhookProcessor(async (schema, inst, codes) => { processed.push({ schema, inst, codes }); return { ok: 1 } }))
afterAll(() => setWebhookProcessor(null))
beforeEach(() => {
  jest.clearAllMocks(); processed.length = 0
  q.mockImplementation(async (sql: string, params: any[]) =>
    /tb_institution/.test(sql) && params[0] === 1 ? [[{ schemaName: 'setes_setes' }]] : [[]])
})
const flush = () => new Promise(r => setImmediate(r))

describe('POST /hooks/bank-channel/:institutionId/:token', () => {
  it('token do canal ativo → 200 {ok, received} SEM JWT, e o processador recebe só os códigos (dedupe fica no processador)', async () => {
    findChannel.mockResolvedValue(liveChannel)
    const res = await request(app).post(`/hooks/bank-channel/1/${TOKEN}`)
      .send([{ codigoSolicitacao: 'uuid-0001-aaaa', seuNumero: '262', situacao: 'RECEBIDO', valorTotalRecebido: '999999' }, { codigoSolicitacao: 'uuid-0002-bbbb' }])
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, received: 2 })
    await flush()
    expect(processed).toEqual([{ schema: 'setes_setes', inst: 1, codes: ['uuid-0001-aaaa', 'uuid-0002-bbbb'] }])
    expect(findChannel).toHaveBeenCalledWith('setes_setes', TOKEN)
  })

  it('token errado → 404 e nada processado', async () => {
    findChannel.mockResolvedValue(null)
    const res = await request(app).post(`/hooks/bank-channel/1/${'b'.repeat(48)}`).send([{ codigoSolicitacao: 'xxxxxxxx-1' }])
    expect(res.status).toBe(404); await flush(); expect(processed).toEqual([])
  })

  it('institution inexistente ou inválida → 404 igual (não vaza qual das duas falhou)', async () => {
    const r1 = await request(app).post(`/hooks/bank-channel/999/${TOKEN}`).send([])
    const r2 = await request(app).post(`/hooks/bank-channel/abc/${TOKEN}`).send([])
    expect(r1.status).toBe(404); expect(r2.status).toBe(404)
    expect(findChannel).not.toHaveBeenCalled()
  })

  it('canal INATIVO → 404 (o banco continua tentando até a Onda 4 ligar; nada muda aqui)', async () => {
    findChannel.mockResolvedValue({ ...liveChannel, active: 'N' })
    const res = await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).send([{ codigoSolicitacao: 'xxxxxxxx-1' }])
    expect(res.status).toBe(404)
  })

  it('payload sem codigoSolicitacao válido → 200 received 0 e nenhum processamento (webhook forjado é inócuo)', async () => {
    findChannel.mockResolvedValue(liveChannel)
    const res = await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).send({ situacao: 'RECEBIDO', codigoSolicitacao: "'; DROP--" })
    expect(res.status).toBe(200); expect(res.body.received).toBe(0)
    await flush(); expect(processed).toEqual([])
  })

  it('extractRequestCodes aceita objeto ou array e filtra o que não parece código', () => {
    expect(extractRequestCodes([{ codigoSolicitacao: 'abcd-1234' }, { codigoSolicitacao: 12 }, { requestCode: 'zzzzzzzz' }, null])).toEqual(['abcd-1234', 'zzzzzzzz'])
    expect(extractRequestCodes({ codigoSolicitacao: 'abcd-1234' })).toEqual(['abcd-1234'])
    expect(extractRequestCodes('x')).toEqual([])
  })
})
