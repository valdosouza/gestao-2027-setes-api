/// <reference types="jest" />
// Onda 2 do endurecer — o TETO GLOBAL do login é ALARME, nunca bloqueio (D-EA4; `Infra-IA/prompts/prompt_endurecer_autenticacao.md`
// §P.5, A1–A9). Relógio controlado. A4 (o alarme não bloqueia o login certo) e A5 (o e-mail INEXISTENTE conta) estão no
// `auth-login-lock-d-ea1.test.ts`, que tem o dublê do banco do login.
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/mailer/mailer', () => ({
  __esModule: true, ...jest.requireActual('../shared/mailer/mailer'),
  sendMail: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFALARM'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))

import logger from '../shared/logger/logger'
import { sendMail, assertOpsAlertReady, opsAlertEmail, opsAlertPreflight } from '../shared/mailer/mailer'
import { recordCrash } from '../shared/errors/crash.repository'
import {
  recordLoginRefusal, resetLoginWatch, setLoginWatchClock, loginWatchSize, waitForPendingLoginAlarms,
  LOGIN_ALARM_FAILURES_PER_MINUTE, LOGIN_ALARM_DISTINCT_ACCOUNTS, LOGIN_ALARM_COOLDOWN_MS,
} from '../modules/auth/login-watch'
import fs from 'fs'
import path from 'path'

const mail = sendMail as jest.Mock
const alarms = () => (logger.error as jest.Mock).mock.calls.filter(c => /^\[ALARME LOGIN\] \d/.test(c[0]))
let t: number
const ENV = { ...process.env }

beforeEach(() => {
  jest.clearAllMocks()
  resetLoginWatch()
  t = Date.parse('2026-11-05T12:00:00Z')
  setLoginWatchClock(() => t)
  process.env = { ...ENV }
  delete process.env.OPS_ALERT_EMAIL
  delete process.env.NODE_ENV
  mail.mockResolvedValue(undefined)
})
afterEach(async () => { await waitForPendingLoginAlarms() })
afterAll(() => { process.env = ENV })

describe('A1 — limiares (D-EA4)', () => {
  it('A1 100 falhas/min não dispara; a 101ª dispara UMA vez (a 102ª não repete)', () => {
    expect(LOGIN_ALARM_FAILURES_PER_MINUTE).toBe(100)
    for (let i = 0; i < 100; i++) { t += 100; recordLoginRefusal('mesma@x.com') }
    expect(alarms()).toHaveLength(0)
    t += 100; recordLoginRefusal('mesma@x.com')
    expect(alarms()).toHaveLength(1)
    t += 100; recordLoginRefusal('mesma@x.com')
    expect(alarms()).toHaveLength(1)
  })

  it('A1 100 falhas espalhadas em MAIS de 1 min não disparam (janela de 60 s)', () => {
    for (let i = 0; i < 300; i++) { t += 700; recordLoginRefusal('mesma@x.com') }   // ~86/min
    expect(alarms()).toHaveLength(0)
  })

  it('A1 30 contas distintas em 5 min não dispara; a 31ª dispara', () => {
    expect(LOGIN_ALARM_DISTINCT_ACCOUNTS).toBe(30)
    for (let i = 0; i < 30; i++) { t += 9_000; recordLoginRefusal(`conta${i}@x.com`) }
    expect(alarms()).toHaveLength(0)
    t += 1_000; recordLoginRefusal('conta30@x.com')
    expect(alarms()).toHaveLength(1)
  })

  it('A1 contas que saíram da janela de 5 min não contam (31 contas em 6 min, nunca 31 juntas)', () => {
    for (let i = 0; i < 31; i++) { t += 12_000; recordLoginRefusal(`conta${i}@x.com`) }   // 12 s × 31 = 6,2 min
    expect(alarms()).toHaveLength(0)
  })

  it('A1 a mesma conta em variantes que o banco iguala (caixa, espaço no fim) conta UMA vez', () => {
    for (let i = 0; i < 40; i++) { t += 1_000; recordLoginRefusal(i % 2 ? 'Valdo@Setes.com.br' : 'valdo@setes.com.br  ') }
    expect(loginWatchSize().accounts).toBe(1)
    expect(alarms()).toHaveLength(0)
  })
})

describe('A2/A3 — no máximo 1 alarme a cada 15 min; log + crashlytics com ref + e-mail à operação', () => {
  it('A2 dentro de 15 min, um e-mail só; depois de 15 min, outro', async () => {
    process.env.OPS_ALERT_EMAIL = 'ops@setes.com.br'
    expect(LOGIN_ALARM_COOLDOWN_MS).toBe(15 * 60_000)
    for (let i = 0; i < 200; i++) { t += 10; recordLoginRefusal(`x${i}@x.com`) }
    t += LOGIN_ALARM_COOLDOWN_MS - 5_000
    for (let i = 0; i < 200; i++) { t += 10; recordLoginRefusal(`y${i}@x.com`) }
    await waitForPendingLoginAlarms()
    expect(mail).toHaveBeenCalledTimes(1)
    t += 60_000
    for (let i = 0; i < 200; i++) { t += 10; recordLoginRefusal(`z${i}@x.com`) }
    await waitForPendingLoginAlarms()
    expect(mail).toHaveBeenCalledTimes(2)
    expect(mail.mock.calls[0][0]).toMatchObject({ to: 'ops@setes.com.br', subject: expect.stringMatching(/\[ALARME LOGIN\].*REFALARM/) })
  })

  it('A3 `[ALARME LOGIN]` no log + recordCrash com ref; nenhum e-mail digitado no log', () => {
    for (let i = 0; i < 31; i++) { t += 1_000; recordLoginRefusal(`segredo${i}@cliente.com`) }
    expect(alarms()).toHaveLength(1)
    expect(alarms()[0][1]).toMatchObject({ ref: 'REFALARM', distinctAccounts5min: 31 })
    expect(recordCrash).toHaveBeenCalledWith(expect.objectContaining({ ref: 'REFALARM', message: expect.stringMatching(/^\[ALARME LOGIN\]/) }))
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toMatch(/segredo\d+@/)
  })

  it('A3 fora de produção, sem OPS_ALERT_EMAIL: só log (nenhum e-mail)', async () => {
    for (let i = 0; i < 31; i++) { t += 1_000; recordLoginRefusal(`a${i}@x.com`) }
    await waitForPendingLoginAlarms()
    expect(alarms()).toHaveLength(1)
    expect(mail).not.toHaveBeenCalled()
  })
})

describe('A6 — memória com TETO', () => {
  it('A6 1 milhão de e-mails distintos (e enormes) não crescem a estrutura', () => {
    const big = 'x'.repeat(5_000)
    for (let i = 0; i < 1_000_000; i++) {
      if (i % 1000 === 0) t += 1
      recordLoginRefusal(i % 100 === 0 ? `${big}${i}@x.com` : `e${i}@x.com`)
    }
    const size = loginWatchSize()
    expect(size.failures).toBeLessThanOrEqual(LOGIN_ALARM_FAILURES_PER_MINUTE + 1)
    expect(size.accounts).toBeLessThanOrEqual(LOGIN_ALARM_DISTINCT_ACCOUNTS + 1)
    expect(alarms()).toHaveLength(1)
  }, 120_000)
})

describe('A7 — OPS_ALERT_EMAIL obrigatório em produção (boot)', () => {
  it('A7 produção sem OPS_ALERT_EMAIL, só de espaços, ou fora da forma (lista, texto) → o boot NÃO sobe', () => {
    process.env.NODE_ENV = 'production'
    for (const v of [undefined, '', '   ', 'ops', 'ops@x.com, b@y.com', 'Ops <ops@x.com>']) {
      if (v === undefined) delete process.env.OPS_ALERT_EMAIL
      else process.env.OPS_ALERT_EMAIL = v
      expect(() => assertOpsAlertReady()).toThrow(/E-mail da operação obrigatório em produção \(D-EA4\)/)
    }
    process.env.OPS_ALERT_EMAIL = 'ops@setes.com.br'
    expect(assertOpsAlertReady()).toBe('alarmes para o***@setes.com.br')
    expect(opsAlertEmail()).toBe('ops@setes.com.br')
  })

  it('A7 fora de produção vazio = só log; inválido = aviso; o boot chama a conferência', () => {
    expect(assertOpsAlertReady()).toMatch(/ausente — fora de produção os alarmes ficam só no LOG/)
    process.env.OPS_ALERT_EMAIL = 'nao-e-email'
    expect(assertOpsAlertReady()).toMatch(/⚠️ OPS_ALERT_EMAIL não é UM endereço/)
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    expect(server).toMatch(/assertOpsAlertReady\(\)/)
  })

  it('A7 a mensagem do boot nunca leva o valor cru (D-EA21)', () => {
    process.env.NODE_ENV = 'production'
    process.env.OPS_ALERT_EMAIL = 'segredo@cliente.com, outro@x.com'
    expect(() => assertOpsAlertReady()).toThrow(/s\*\*\*@cliente\.com/)
    try { assertOpsAlertReady() } catch (e) { expect(String(e)).not.toContain('segredo@') }
  })
})

describe('A8 — falha do SMTP no e-mail de alarme = log; o login segue', () => {
  it('A8 sendMail rejeita → logger.error mascarado, nenhuma exceção sobe', async () => {
    process.env.OPS_ALERT_EMAIL = 'ops@setes.com.br'
    mail.mockRejectedValue(Object.assign(new Error('550 mailbox <ops@setes.com.br> unavailable'), { code: 'EENVELOPE', responseCode: 550 }))
    expect(() => { for (let i = 0; i < 31; i++) { t += 1_000; recordLoginRefusal(`a${i}@x.com`) } }).not.toThrow()
    await waitForPendingLoginAlarms()
    const err = (logger.error as jest.Mock).mock.calls.find(c => /falha no envio do e-mail à operação/.test(c[0]))
    expect(err).toBeDefined()
    expect(JSON.stringify(err)).not.toContain('ops@setes.com.br')
  })
})

describe('A9 — o pré-voo confere OPS_ALERT_EMAIL como confere o SMTP', () => {
  it('A9 produção sem / inválido → item BLOQUEANTE; válido → libera; fora de produção → aviso; nunca o valor cru', () => {
    process.env.NODE_ENV = 'production'
    expect(opsAlertPreflight().blocking).toBe(true)
    process.env.OPS_ALERT_EMAIL = 'a@x.com; b@y.com'
    const bad = opsAlertPreflight()
    expect(bad.blocking).toBe(true)
    expect(bad.lines.join(' | ')).not.toContain('a@x.com')
    process.env.OPS_ALERT_EMAIL = 'ops@setes.com.br'
    const good = opsAlertPreflight()
    expect([good.blocking, good.lines.join(' | ')]).toEqual([false, expect.stringMatching(/✓ OPS_ALERT_EMAIL = o\*\*\*@setes\.com\.br/)])
    delete process.env.NODE_ENV
    delete process.env.OPS_ALERT_EMAIL
    expect(opsAlertPreflight()).toEqual({ blocking: false, lines: [expect.stringMatching(/D-EA4/), expect.stringMatching(/⚠️ OPS_ALERT_EMAIL ausente/)] })
  })

  it('A9 o script do pré-voo usa a peça e SOMA o bloqueio aos itens em voo (cerca no texto)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'pre-deploy-tz-check.ts'), 'utf8')
    expect(src).toMatch(/opsAlertPreflight\(\)/)
    expect(src).toMatch(/inFlight \+= checkOpsAlert\(\)/)
  })
})
