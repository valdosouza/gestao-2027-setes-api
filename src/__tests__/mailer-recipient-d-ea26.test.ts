/// <reference types="jest" />
// D-EA26 (Valdo 2026-11-04, "(a) Recusar em todos" — prompt_endurecer_autenticacao.md): a casa só manda e-mail para UM endereço válido.
// A regra é UMA e mora na `@shared/mailer`: o valor APARADO passa no MESMO validador do cadastro (`z.string().email()`) e é ele que vai ao
// transporte; qualquer outra coisa (lista, nome + endereço, quebra de linha, vazio) é recusada ANTES do transporte e ANTES do modo dev.
const mockSendMail = jest.fn()
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn(() => ({ sendMail: mockSendMail, verify: jest.fn() })) },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import { sendMail, singleMailAddress, MailRecipientRejectedError, mailErrorForLog } from '../shared/mailer/mailer'
import { pickLoginEmail } from '../modules/auth/super-password-reset'
import logger from '../shared/logger/logger'

const SMTP = { SMTP_HOST: 'smtp.teste.local', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASSWORD: 'p', SMTP_FROM: 'nao-responda@setes.com.br' }
const saved: Record<string, string | undefined> = {}
const msg = (to: any) => ({ to, subject: 'Assunto', html: '<p>segredo 123456</p>', text: 'segredo 123456' })

beforeEach(() => {
  for (const k of [...Object.keys(SMTP), 'NODE_ENV']) saved[k] = process.env[k]
  mockSendMail.mockReset().mockResolvedValue({ messageId: 'id' })
  for (const f of ['info', 'warn', 'error'] as const) (logger[f] as jest.Mock).mockClear()
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})
const allLogs = () => JSON.stringify([
  (logger.info as jest.Mock).mock.calls, (logger.warn as jest.Mock).mock.calls, (logger.error as jest.Mock).mock.calls,
])

/** Valores que o nodemailer leria como MAIS de um destinatário (ou como cabeçalho) — todos recusados. */
const RECUSADOS = [
  'a@x.com; b@y.com', 'a@x.com, b@y.com', 'a@x.com,b@y.com', 'a@x.com b@y.com', 'Fulano <a@x.com>', '"a@x.com" <b@y.com>',
  'a@x.com\nBcc: b@y.com', 'a@x.com\r\nb@y.com', '<a@x.com>, b@y.com', 'grupo: a@x.com, b@y.com;', '', '   ', 'semarroba', '@x.com',
]

describe('D-EA26 — o predicado da peça', () => {
  it('aceita UM endereço válido e devolve o valor APARADO (o que valida é o que envia)', () => {
    expect(singleMailAddress('valdo@setes.com.br')).toBe('valdo@setes.com.br')
    expect(singleMailAddress('  valdo@setes.com.br  ')).toBe('valdo@setes.com.br')
    expect(singleMailAddress('ti+avisos@cliente.com.br')).toBe('ti+avisos@cliente.com.br')
  })
  it.each(RECUSADOS)('recusa %j', raw => { expect(singleMailAddress(raw)).toBeNull() })
  it('recusa null/undefined', () => { expect(singleMailAddress(null)).toBeNull(); expect(singleMailAddress(undefined)).toBeNull() })
  it('a escolha do e-mail de login do Super usa o MESMO predicado (uma regra só — D-EA23 × D-EA26)', () => {
    for (const raw of RECUSADOS) expect(pickLoginEmail([raw])).toBeNull()
    expect(pickLoginEmail(['a@x.com; b@y.com', ' ok@x.com '])).toBe('ok@x.com')
  })
})

describe('D-EA26 — sendMail recusa antes do transporte', () => {
  it('com SMTP: endereço único vai ao transporte APARADO', async () => {
    Object.assign(process.env, SMTP)
    await sendMail(msg(' valdo@setes.com.br '))
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'valdo@setes.com.br' }))
  })

  it.each(RECUSADOS)('com SMTP: %j → lança MAIL_RECIPIENT_INVALID e o transporte nunca é chamado', async raw => {
    Object.assign(process.env, SMTP)
    await expect(sendMail(msg(raw))).rejects.toBeInstanceOf(MailRecipientRejectedError)
    expect(mockSendMail).not.toHaveBeenCalled()
  })

  it('sem SMTP (modo dev): a MESMA recusa, e o conteúdo da mensagem recusada não vai ao log', async () => {
    delete process.env.SMTP_HOST
    await expect(sendMail(msg('a@x.com; b@y.com'))).rejects.toMatchObject({ code: 'MAIL_RECIPIENT_INVALID' })
    expect(allLogs()).not.toMatch(/segredo|123456/)
  })

  it('o erro nunca leva o endereço cru — nem na mensagem, nem pelo mailErrorForLog (D-EA21)', async () => {
    Object.assign(process.env, SMTP)
    const err = await sendMail(msg('fulano.silva@cliente.com.br; terceiro@y.com')).catch(e => e)
    expect(err.message).not.toMatch(/fulano\.silva@|terceiro@y\.com/)
    expect(err.message).toMatch(/f\*\*\*@cliente\.com\.br/)
    expect(mailErrorForLog(err)).toEqual(expect.objectContaining({ code: 'MAIL_RECIPIENT_INVALID' }))
    expect(JSON.stringify(mailErrorForLog(err))).not.toMatch(/fulano\.silva@|terceiro@y\.com/)
  })

  it('valor que não é texto (arranjo, número) também é recusado — a porta é tipada como texto, o dado pode não ser', async () => {
    Object.assign(process.env, SMTP)
    await expect(sendMail(msg(['a@x.com', 'b@y.com']))).rejects.toBeInstanceOf(MailRecipientRejectedError)
    await expect(sendMail(msg(42))).rejects.toBeInstanceOf(MailRecipientRejectedError)
    expect(mockSendMail).not.toHaveBeenCalled()
  })
})
