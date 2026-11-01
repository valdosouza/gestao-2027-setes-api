/// <reference types="jest" />
// D-EA21 (Valdo 2026-11-01, "(a) Mascarar em todos" — prompt_endurecer_autenticacao.md, Rodada 4): todo e-mail que vai ao LOG sai
// MASCARADO — a `@shared/mailer` (o destinatário de TODO e-mail da casa: código de recuperação, aviso ao dono — D-RS4 —, aviso ao Super —
// D-RS13) e o erro do SMTP, que o nodemailer devolve com o endereço na mensagem e nos campos `response`/`rejected`.
const mockSendMail = jest.fn()
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn(() => ({ sendMail: mockSendMail, verify: jest.fn() })) },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import { sendMail, maskEmail, mailErrorForLog } from '../shared/mailer/mailer'
import logger from '../shared/logger/logger'

const SMTP = { SMTP_HOST: 'smtp.teste.local', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASSWORD: 'p', SMTP_FROM: 'nao-responda@setes.com.br' }
const saved: Record<string, string | undefined> = {}
const MSG = { to: 'valdo@setes.com.br', subject: 'Assunto', html: '<p>x</p>', text: 'x' }

beforeEach(() => {
  for (const k of [...Object.keys(SMTP), 'NODE_ENV']) saved[k] = process.env[k]
  mockSendMail.mockReset().mockResolvedValue({ messageId: 'id' })
  ;(logger.info as jest.Mock).mockClear(); (logger.warn as jest.Mock).mockClear()
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})
const allLogs = () => JSON.stringify([...(logger.info as jest.Mock).mock.calls, ...(logger.warn as jest.Mock).mock.calls])

describe('D-EA21 — o e-mail nunca vai inteiro ao log', () => {
  it('a máscara: 1ª letra + domínio; vazio e sem arroba têm forma própria', () => {
    expect(maskEmail('valdo@setes.com.br')).toBe('v***@setes.com.br')
    expect(maskEmail(null)).toBe('(sem e-mail de login)')
    expect(maskEmail(undefined)).toBe('(sem e-mail de login)')
    expect(maskEmail('semarroba')).toBe('***')
    expect(maskEmail('@semnome.com')).toBe('***')
  })

  it('com SMTP: o envio leva o endereço INTEIRO ao transporte, mas o log "Email enviado" só o mascarado', async () => {
    Object.assign(process.env, SMTP)
    await sendMail(MSG)
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'valdo@setes.com.br' }))
    expect(logger.info).toHaveBeenCalledWith('Email enviado', { to: 'v***@setes.com.br', subject: 'Assunto' })
    expect(allLogs()).not.toMatch(/valdo@setes/)
  })

  it('sem SMTP (modo dev): o aviso no log também só leva o mascarado', async () => {
    delete process.env.SMTP_HOST
    await sendMail(MSG)
    expect(mockSendMail).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/SMTP não configurado/), { to: 'v***@setes.com.br', subject: 'Assunto' })
    expect(allLogs()).not.toMatch(/valdo@setes/)
  })

  it('o erro do SMTP: código e resposta ficam, TODO endereço da mensagem é mascarado, `response`/`rejected` crus nunca saem', () => {
    const err = Object.assign(
      new Error('Can\'t send mail - all recipients were rejected: 550 5.1.1 <valdo@setes.com.br>: Recipient address rejected; cc fulano.silva@cliente.com.br'),
      { code: 'EENVELOPE', responseCode: 550, response: '550 5.1.1 <valdo@setes.com.br>', rejected: ['valdo@setes.com.br'] })
    const out = mailErrorForLog(err)
    expect(out).toEqual({
      code: 'EENVELOPE', responseCode: 550,
      message: 'Can\'t send mail - all recipients were rejected: 550 5.1.1 <v***@setes.com.br>: Recipient address rejected; cc f***@cliente.com.br',
    })
    expect(JSON.stringify(out)).not.toMatch(/valdo@|fulano\.silva@/)
    expect(Object.keys(out)).toEqual(['code', 'responseCode', 'message'])
  })

  it('o erro que não é Error (texto solto) também passa pela máscara', () => {
    expect(mailErrorForLog('falhou para valdo@setes.com.br').message).toBe('falhou para v***@setes.com.br')
    expect(mailErrorForLog(null).message).toBe('null')
  })
})
