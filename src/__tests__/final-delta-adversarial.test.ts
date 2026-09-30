// Gate adversarial do delta final (2026-09-30) — Q-ADV1a.
// ACHADO HIGH (provado no Node 21.7.3 com servidor TLS local): o https.globalAgent do Node ≥ 19 é
// keep-alive; num socket REUSADO o evento 'socket' dispara, mas 'secureConnect' NUNCA (o aperto de
// mão foi na requisição anterior) → `afterHandshake` fica false e um erro TLS DEPOIS do envio
// (ex.: alerta "bad record mac") é lido como CREDENCIAL → 409 AUTH_FAILED → F conclusivo (source P,
// que a reconferência Q-ADV1b não revisita), embora o DPS possa ter chegado ao fisco.
// `it.failing` documenta o defeito sem mexer em código de produção; ao corrigir, trocar por `it`.
import { EventEmitter } from 'events'

jest.mock('https', () => ({ request: jest.fn() }))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import https from 'https'
import { authorityJson, transport, httpsRequest } from '../shared/tax-authority/https-json'

type Scenario = { reused: boolean }

function fakeRequest({ reused }: Scenario) {
  ;(https.request as jest.Mock).mockImplementation(() => {
    const req: any = new EventEmitter()
    req.reusedSocket = reused
    req.write = jest.fn()
    req.destroy = jest.fn()
    req.end = jest.fn(() => {
      setImmediate(() => {
        const socket = new EventEmitter()
        req.emit('socket', socket)
        if (!reused) socket.emit('secureConnect')        // só socket NOVO faz handshake nesta requisição
        // o pedido já foi escrito; a conexão cai com um alerta TLS pós-handshake
        const err: any = new Error('write EPROTO 1C:error:0A000119:SSL routines:ssl3_get_record:decryption failed or bad record mac')
        err.code = 'EPROTO'
        req.emit('error', err)
      })
    })
    return req
  })
}

const call = { url: 'https://sefin.example/SefinNacional/nfse', method: 'POST', headers: {}, body: '{}', cert: 'c', key: 'k' } as any

describe('Q-ADV1a — erro TLS depois do envio é AMBÍGUO (503), nunca credencial', () => {
  beforeEach(() => { transport.request = httpsRequest })

  it('socket novo (secureConnect visto) → 503 FISCAL_AUTHORITY_UNAVAILABLE', async () => {
    fakeRequest({ reused: false })
    await expect(authorityJson(call, 'nfse')).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
  })

  it('socket REUSADO pelo keep-alive (sem secureConnect) → também 503, não 409 AUTH_FAILED', async () => {
    fakeRequest({ reused: true })
    await expect(authorityJson(call, 'nfse')).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
  })
})
