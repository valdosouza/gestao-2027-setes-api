/// <reference types="jest" />
// D-RS5 (Valdo, 2026-10-20; executada 2026-10-21 — prompt_privilegios_interfaces.md §13.10): SMTP OBRIGATÓRIO em produção.
// A peça REAL `@shared/mailer` (nodemailer dublado): com NODE_ENV=production e SMTP ausente/incompleto o boot RECUSA subir com
// mensagem clara; fora de produção segue o modo dev (código no log); o resumo do boot/pré-voo nunca leva a senha; a conferência
// de conexão do pré-voo (`verifyMailerConnection`) autentica sem enviar e falha fechado (tempo, erro, configuração incompleta).
const mockVerify = jest.fn()
const mockSendMail = jest.fn()
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn(() => ({ verify: mockVerify, sendMail: mockSendMail })) },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import nodemailer from 'nodemailer'
import {
  assertMailerReady, mailerConfigProblems, describeMailerConfig, verifyMailerConnection, sendMail, isProduction, isMailerConfigured,
  nodeEnvWarning,
} from '../shared/mailer/mailer'

const SMTP_KEYS = ['NODE_ENV', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const
const saved: Partial<Record<string, string | undefined>> = {}
const SECRET = 'S3nh4-Sup3r-S3cr3t4'

function env(vars: Partial<Record<typeof SMTP_KEYS[number], string>>): void {
  for (const k of SMTP_KEYS) delete process.env[k]                          // `= undefined` gravaria "undefined" (lição da Q-PV38)
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v
}
const complete = { SMTP_HOST: 'smtp.setes.com.br', SMTP_PORT: '587', SMTP_USER: 'nao-responda@setes.com.br', SMTP_PASSWORD: SECRET, SMTP_FROM: 'Setes ERP <nao-responda@setes.com.br>' }

beforeAll(() => { for (const k of SMTP_KEYS) saved[k] = process.env[k] })
afterAll(() => { for (const k of SMTP_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })
beforeEach(() => { jest.clearAllMocks(); mockVerify.mockResolvedValue(true); mockSendMail.mockResolvedValue({ messageId: 'x' }) })

describe('D-RS5 — boot em PRODUÇÃO recusa subir sem SMTP', () => {
  it('SMTP ausente = o boot NÃO sobe, com a mensagem apontando as chaves e a decisão', () => {
    env({ NODE_ENV: 'production' })
    expect(isProduction()).toBe(true)
    expect(() => assertMailerReady()).toThrow(/SMTP obrigatório em produção \(D-RS5\)/)
    expect(() => assertMailerReady()).toThrow(/SMTP_HOST ausente/)
    expect(() => assertMailerReady()).toThrow(/SMTP_HOST\/SMTP_PORT\/SMTP_USER\/SMTP_PASSWORD\/SMTP_FROM/)
  })

  it.each([
    ['credencial pela metade (usuário sem senha)', { ...complete, SMTP_PASSWORD: undefined }, /SMTP_USER informado sem SMTP_PASSWORD/],
    ['credencial pela metade (senha sem usuário)', { ...complete, SMTP_USER: undefined, SMTP_FROM: 'x@y' }, /SMTP_PASSWORD informada sem SMTP_USER/],
    ['porta inválida (texto)', { ...complete, SMTP_PORT: 'abc' }, /SMTP_PORT inválida/],
    ['porta inválida (fora da faixa)', { ...complete, SMTP_PORT: '70000' }, /SMTP_PORT inválida/],
    ['sem remetente (sem SMTP_FROM e sem SMTP_USER)', { SMTP_HOST: 'h', SMTP_PORT: '25' }, /remetente ausente/],
  ])('SMTP incompleto — %s — o boot NÃO sobe', (_label, vars, pattern) => {
    env({ NODE_ENV: 'production', ...(vars as any) })
    expect(() => assertMailerReady()).toThrow(pattern)
  })

  it('SMTP completo em produção: sobe e o resumo do log NUNCA leva a senha', () => {
    env({ NODE_ENV: 'production', ...complete })
    const summary = assertMailerReady()
    expect(summary).toMatch(/smtp smtp\.setes\.com\.br:587 \(STARTTLS\)/)
    expect(summary).toMatch(/com autenticação/)
    expect(summary).not.toContain(SECRET)
    expect(describeMailerConfig()).not.toContain(SECRET)
    expect(mailerConfigProblems()).toEqual([])
  })

  it('relay sem autenticação (sem usuário E sem senha, com remetente) é configuração completa', () => {
    env({ NODE_ENV: 'production', SMTP_HOST: 'relay.interno', SMTP_PORT: '25', SMTP_FROM: 'erp@setes.com.br' })
    expect(mailerConfigProblems()).toEqual([])
    expect(assertMailerReady()).toMatch(/sem autenticação/)
  })

  it('a porta vazia vale 587 (padrão da casa) e 465 é SSL implícito', () => {
    env({ NODE_ENV: 'production', ...complete, SMTP_PORT: '' })
    expect(assertMailerReady()).toMatch(/:587 \(STARTTLS\)/)
    env({ NODE_ENV: 'production', ...complete, SMTP_PORT: '465' })
    expect(assertMailerReady()).toMatch(/:465 \(SSL\)/)
  })
})

describe('D-RS5 — fora de produção segue o modo dev', () => {
  it('sem NODE_ENV e sem SMTP: sobe, avisando que o código vai ao LOG', () => {
    env({})
    expect(isProduction()).toBe(false)
    expect(isMailerConfigured()).toBe(false)
    expect(assertMailerReady()).toMatch(/modo DEV: o código de recuperação de senha vai ao LOG/)
  })

  it('NODE_ENV=development com SMTP incompleto: sobe com aviso (⚠️) dizendo que em produção recusaria', () => {
    env({ NODE_ENV: 'development', SMTP_HOST: 'h', SMTP_USER: 'u' })
    const s = assertMailerReady()
    expect(s).toMatch(/⚠️ incompleta: SMTP_USER informado sem SMTP_PASSWORD/)
    expect(s).toMatch(/em produção o boot recusaria/)
  })

  it('NODE_ENV normalizado (gate adversarial): "Production" e "production " SÃO produção (com aviso de grafia); "prod" NÃO é, e o boot avisa que a exigência está desligada', () => {
    env({ NODE_ENV: 'Production' })
    expect(isProduction()).toBe(true)
    expect(nodeEnvWarning()).toMatch(/lido como production/)
    env({ NODE_ENV: 'production ' })
    expect(isProduction()).toBe(true)
    expect(() => assertMailerReady()).toThrow(/SMTP obrigatório em produção/)
    env({ NODE_ENV: 'prod' })
    expect(isProduction()).toBe(false)
    expect(nodeEnvWarning()).toMatch(/NÃO é reconhecido como produção.*DESLIGADA/)
    env({ NODE_ENV: 'development' })
    expect(nodeEnvWarning()).toBeUndefined()
    env({ NODE_ENV: 'production' })
    expect(nodeEnvWarning()).toBeUndefined()
  })

  it('SMTP_HOST só com espaços NÃO conta como configurado (gate adversarial: o código iria a lugar nenhum e ainda consumiria o teto)', () => {
    env({ SMTP_HOST: '   ', SMTP_PORT: '587', SMTP_FROM: 'x@y' })
    expect(isMailerConfigured()).toBe(false)
    expect(assertMailerReady()).toMatch(/modo DEV/)
    env({ NODE_ENV: 'production', SMTP_HOST: '   ', SMTP_PORT: '587', SMTP_FROM: 'x@y' })
    expect(() => assertMailerReady()).toThrow(/SMTP_HOST ausente/)
  })
})

describe('D-RS5 — pré-voo: verifyMailerConnection autentica sem enviar e falha fechado', () => {
  it('configuração completa: abre a conexão (verify) e NÃO envia nada', async () => {
    env({ ...complete })
    const r = await verifyMailerConnection(1000)
    expect(r).toEqual({ ok: true, detail: expect.stringContaining('smtp.setes.com.br:587') })
    expect(mockVerify).toHaveBeenCalledTimes(1)
    expect(mockSendMail).not.toHaveBeenCalled()
    expect((nodemailer.createTransport as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({
      host: 'smtp.setes.com.br', port: 587, secure: false, requireTLS: true, auth: { user: complete.SMTP_USER, pass: SECRET },
    }))
  })

  it('configuração incompleta: falha SEM abrir conexão', async () => {
    env({ SMTP_HOST: 'h', SMTP_USER: 'u' })
    const r = await verifyMailerConnection(1000)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/configuração incompleta: SMTP_USER informado sem SMTP_PASSWORD/)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('SMTP recusa (erro do servidor): falha com código/mensagem e NUNCA a senha', async () => {
    env({ ...complete })
    mockVerify.mockRejectedValue(Object.assign(new Error('Invalid login: 535 Authentication failed'), { code: 'EAUTH', responseCode: 535 }))
    const r = await verifyMailerConnection(1000)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/EAUTH 535 Invalid login/)
    expect(r.detail).not.toContain(SECRET)
  })

  it('SMTP mudo: estourou o tempo = falha', async () => {
    env({ ...complete })
    mockVerify.mockImplementation(() => new Promise(() => undefined))
    const r = await verifyMailerConnection(30)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/sem resposta do SMTP em 30 ms/)
  })
})

describe('D-RS5 — sendMail', () => {
  it('sem SMTP não cria transporte nem envia (modo dev: aviso no log)', async () => {
    env({})
    await sendMail({ to: 'a@x', subject: 's', html: '<p/>' })
    expect(nodemailer.createTransport).not.toHaveBeenCalled()
    expect(mockSendMail).not.toHaveBeenCalled()
  })

  it('com SMTP envia pelo remetente configurado', async () => {
    env({ ...complete })
    await sendMail({ to: 'a@x', subject: 's', html: '<p/>', text: 't' })
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ from: complete.SMTP_FROM, to: 'a@x', subject: 's' }))
  })
})
