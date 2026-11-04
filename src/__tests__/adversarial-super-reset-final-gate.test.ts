/// <reference types="jest" />
// GATE ADVERSARIAL DO DELTA FINAL do item 0 (2026-11-04 — branch `super-reset`): ataca o que entrou depois dos últimos gates —
//   D-EA23 (`pickLoginEmail` + o ato devolvendo `loginEmail`; uso no script),
//   D-EA24 (`SUPER_NOTICE_CAP_MS`/`sendSuperResetNotice` + `dnsTimeout` do transporte),
//   D-EA26 (`singleMailAddress`, `MailRecipientRejectedError`, `sendMail` — commit 939b6bc).
// Partes:
//   1. a peça de envio REAL sobre o nodemailer REAL em `jsonTransport` (nenhum e-mail sai: o transporte só serializa);
//   2. o script INTEIRO no processo do jest (banco dublado — o GROUP_CONCAT da lista emulado byte a byte; nenhum e-mail sai);
//   3. AO VIVO em SCHEMA DESCARTÁVEL (MariaDB do dev; `setes_central` só LIDA — CHECKSUM antes/depois; DROP no fim).
// Convenção da casa: `it` = [RESISTIU] (o ataque falhou); `achado` (= `it.failing`) = [ACHADO] — a asserção SEGURA que o código atual
// quebra (verde enquanto o achado existir; corrigido, o jest acusa e o `achado` vira `it`). Não edita produção. O `.env` real nunca
// entra no processo (dotenv dublado) — só a parte 3 lê DB_* dele para o schema descartável.
import fs from 'fs'
import path from 'path'

// ---- dublês (prefixo `mock` para o jest.mock içado) -------------------------------------------------------------------------------
const mockPool = { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() }
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const mockCreated: any[] = []                                     // opções que o mailer passou ao createTransport
const mockSent: Array<{ m: any; info: any }> = []                 // o que o nodemailer REAL (jsonTransport) serializou
let mockMode: 'json' | 'throw-sync' | 'never' = 'json'

jest.mock('dotenv/config', () => ({}))
jest.mock('dotenv', () => {
  const actual = jest.requireActual('dotenv')
  const config = () => ({ parsed: {} })
  return { __esModule: true, ...actual, config, default: { ...actual, config } }
})
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: mockPool }))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: mockLog }))
jest.mock('nodemailer', () => {
  const real = jest.requireActual('nodemailer')
  const create = (opts: any) => {
    mockCreated.push(opts)
    const json = real.createTransport({ jsonTransport: true })        // o nodemailer REAL monta envelope e cabeçalhos; nada sai
    return {
      verify: async () => true,
      sendMail: (m: any) => {
        if (mockMode === 'throw-sync') throw Object.assign(new Error(`550 5.1.1 <${m.to}>: Recipient address rejected`), { code: 'EENVELOPE', responseCode: 550 })
        if (mockMode === 'never') return new Promise(() => undefined)
        return json.sendMail(m).then((info: any) => { mockSent.push({ m, info }); return info })
      },
    }
  }
  return { __esModule: true, default: { createTransport: create }, createTransport: create }
})
jest.mock('../shared/db/counters', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/db/counters'),
  detectLockWaitSupport: jest.fn(async () => true),
  isLockWaitSupported: () => true,
}))
jest.mock('../shared/time-zone', () => {
  const actual = jest.requireActual('../shared/time-zone')
  return { __esModule: true, ...actual, institutionZoneFor: async () => 'America/Sao_Paulo' }
})

import addressparser from 'nodemailer/lib/addressparser'
import { sendMail, singleMailAddress, MailRecipientRejectedError, mailErrorForLog, maskEmail } from '../shared/mailer/mailer'
import {
  pickLoginEmail, sendSuperResetNotice, SUPER_NOTICE_CAP_MS, SuperAccount,
} from '../modules/auth/super-password-reset'

const REPO = path.join(__dirname, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'reset-super-password.ts')
const achado: jest.It = process.env.ADV_SHOW_ACHADOS ? it : it.failing

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'NODE_ENV'] as const
let envBefore: Record<string, string | undefined>
const allLogText = () => JSON.stringify([mockLog.info.mock.calls, mockLog.warn.mock.calls, mockLog.error.mock.calls])

beforeEach(() => {
  envBefore = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  process.env.SMTP_HOST = 'smtp.adv-final.test'
  process.env.SMTP_PORT = '587'
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASSWORD
  process.env.SMTP_FROM = 'Setes ERP <nao-responda@adv-final.test>'
  process.env.NODE_ENV = 'test'
  mockMode = 'json'
  mockCreated.length = 0
  mockSent.length = 0
  for (const l of ['info', 'warn', 'error'] as const) mockLog[l].mockReset()
})
afterEach(() => {
  for (const k of ENV_KEYS) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k] }
})

const msg = (to: any) => ({ to, subject: 'Assunto ADV', text: 'segredo 654321', html: '<p>segredo 654321</p>' })

// ======================================================================================================================================
// Parte 1 — D-EA26: o predicado × o que o nodemailer REAL faz com o valor aceito
// ======================================================================================================================================
/** Valores que PASSAM no `z.string().email()` da zod 3.25 e têm cara de ataque (aspas simples, sinais, controle no fim, BOM, NBSP). */
const ACEITOS_HOSTIS: Array<[string, string]> = [
  ["o'brien@x.com", "o'brien@x.com"], ["'a@x.com", "'a@x.com"], ["''a@x.com", "''a@x.com"], ["a''b@x.com", "a''b@x.com"],
  ['-a@x.com', '-a@x.com'], ['+a@x.com', '+a@x.com'], ['_@x.com', '_@x.com'], ['a@x-.com', 'a@x-.com'], ['a@1.com', 'a@1.com'],
  ['a@xn--bcher-kva.com', 'a@xn--bcher-kva.com'], ['A@X.COM', 'A@X.COM'],
  ['a@x.com\n', 'a@x.com'], ['a@x.com\r', 'a@x.com'], ['\ta@x.com\t', 'a@x.com'], ['a@x.com\u000B', 'a@x.com'],
  ['﻿a@x.com﻿', 'a@x.com'], ['a@x.com ', 'a@x.com'], ['a@x.com ', 'a@x.com'],
]
/** Valores que o nodemailer leria como lista/cabeçalho/endereço diferente, ou que não são ASCII — todos têm de ser recusados. */
const RECUSADOS_HOSTIS = [
  'vá@x.com', 'a@é.com', 'ａ@x.com', 'a@x.comK', 'ſ@x.com', 'a@x.Kom',          // unicode, largura total, K/ſ do /i
  'a@x.com(c)', 'a(c)@x.com', '"a"@x.com', '"a,b"@x.com', 'a%b@x.com', 'a\\b@x.com', 'a b@x.com', 'a b@x.com',
  'a@x.com\u0000', 'a\u0000@x.com', 'a b@x.com', 'a@x.com​', '​a@x.com',
  "a'b,c@x.com", "a'<b>@x.com", "a@x.com'", 'a.@x.com', 'a..b@x.com', '.a@x.com', 'a@x..com', 'a@[127.0.0.1]', 'a@localhost',
  'a@x.com\nBcc: e@evil.test', 'a@x.com\r\nTo: e@evil.test', 'a@x.com,', ',a@x.com', 'a@x.com;e@evil.test', 'a@x.com e@evil.test',
  '=?utf-8?Q?a=40x.com?= <e@evil.test>', 'a@x.com <e@evil.test>',
]

describe('ADV-FG D-EA26 — o que valida é o que vai ao transporte (nodemailer REAL, jsonTransport)', () => {
  it.each(ACEITOS_HOSTIS)('[RESISTIU] %j → UM destinatário no envelope e no cabeçalho To, igual ao valor aparado', async (raw, want) => {
    expect(singleMailAddress(raw)).toBe(want)
    await sendMail(msg(raw))
    expect(mockSent).toHaveLength(1)
    const { info } = mockSent[0]
    const sent = want.replace(/@.*/, d => d.toLowerCase())                     // o nodemailer só põe o DOMÍNIO em caixa baixa (inofensivo)
    expect(info.envelope.to).toEqual([sent])                                   // o RCPT TO real seria UM só
    const headerTo = JSON.parse(info.message).to as Array<{ address: string; name: string }>   // o To que o nodemailer serializou
    expect(headerTo.map(a => [a.address.toLowerCase(), a.name])).toEqual([[want.toLowerCase(), '']])   // UM endereço, sem nome // o To que o nodemailer serializou: UM endereço, sem nome
    expect(addressparser(want, { flatten: true }).map(a => a.address)).toEqual([want])
  })

  it.each(RECUSADOS_HOSTIS)('[RESISTIU] %j → MAIL_RECIPIENT_INVALID antes do transporte (com SMTP)', async raw => {
    await expect(sendMail(msg(raw))).rejects.toBeInstanceOf(MailRecipientRejectedError)
    expect(mockCreated).toHaveLength(0)                                        // nem chegou a montar o transporte
    expect(allLogText()).not.toMatch(/654321/)
  })

  it('[RESISTIU] recusa com valor de cabeçalho injetado: a mensagem do erro e o mailErrorForLog não levam endereço inteiro', async () => {
    const err = await sendMail(msg('fulano.silva@cliente.com.br\nBcc: espiao@evil.test')).catch(e => e)
    expect(err).toBeInstanceOf(MailRecipientRejectedError)
    const forLog = JSON.stringify(mailErrorForLog(err))
    expect(forLog).toMatch(/MAIL_RECIPIENT_INVALID/)
    expect(forLog).not.toMatch(/fulano\.silva@|espiao@evil/)
  })

  it('[RESISTIU] D-EA24: o transporte recebe dnsTimeout explícito de 15 s junto dos tetos do SMTP', async () => {
    await sendMail(msg('valdo@setes.com.br'))
    expect(mockCreated[0]).toEqual(expect.objectContaining({
      dnsTimeout: 15_000, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    }))
  })

  // ADV-FG-03 (LOW, D-EA21 exercida pela porta da D-EA26): o aspas simples é ACEITO pelo z.email() (o endereço vai ao transporte) mas é
  // SEPARADOR para o `maskEmail` — o log "Email enviado" leva quase toda a parte local: "joao.silva'x***@cliente.com.br" em vez de
  // "j***@cliente.com.br". A D-EA21 promete "1ª letra + domínio" para todo e-mail que vai ao log.
  it('[CORRIGIDO] ADV-FG-03: e-mail com aspas simples (aceito pela peça) sai no log com a parte local quase inteira', async () => {
    await sendMail(msg("joao.silva'x@cliente.com.br"))
    const logged = mockLog.info.mock.calls.find(c => /Email enviado/.test(c[0]))?.[1] as { to: string }
    expect(logged.to).toBe('j***@cliente.com.br')
    expect(allLogText()).not.toMatch(/joao\.silva/)
  })
})

// ======================================================================================================================================
// Parte 1b — D-EA24 × D-EA26: o aviso ao Super com recusa (da peça ou SÍNCRONA do transporte) nunca espera o teto
// ======================================================================================================================================
describe('ADV-FG D-EA24 — teto de 60 s × recusa imediata', () => {
  const at = new Date('2026-11-04T12:00:00Z')
  const sup = (loginEmail: string | null): SuperAccount => ({ id: 7, active: 'S', loginEmail })

  it('[RESISTIU] transporte que recusa SÍNCRONO (550 no RCPT): "failed" na hora (não espera 60 s), log mascarado, sem senha', async () => {
    mockMode = 'throw-sync'
    const t0 = Date.now()
    const out = await sendSuperResetNotice(sup('ana.souza@setes.com.br'), at, 'America/Sao_Paulo')
    expect(out).toBe('failed')
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(SUPER_NOTICE_CAP_MS).toBe(60_000)
    expect(allLogText()).toMatch(/a\*\*\*@setes\.com\.br/)
    expect(allLogText()).not.toMatch(/ana\.souza@/)
  })

  it.each([
    ['lista', 'ana@setes.com.br, espiao@evil.test'],
    ['quebra + Bcc', 'ana@setes.com.br\nBcc: espiao@evil.test'],
    ['nome + endereço', 'Ana <ana@setes.com.br>'],
  ])('[RESISTIU] e-mail gravado %s: "failed" na hora, o transporte nunca é montado, nada inteiro no log', async (_n, raw) => {
    const t0 = Date.now()
    expect(await sendSuperResetNotice(sup(raw), at, 'America/Sao_Paulo')).toBe('failed')
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(mockCreated).toHaveLength(0)
    expect(allLogText()).not.toMatch(/ana@setes|espiao@evil/)
  })

  it('[RESISTIU] envio que nunca termina: "unconfirmed" no teto (relógio curto), sem rejeição solta', async () => {
    mockMode = 'never'
    const out = await sendSuperResetNotice(sup('ana@setes.com.br'), at, 'America/Sao_Paulo', 50)
    expect(out).toBe('unconfirmed')
    expect(mockLog.warn.mock.calls.some(c => /D-EA24/.test(c[0]))).toBe(true)
  })

  it('[RESISTIU] uma regra só: candidato com quebra de linha DENTRO (um e-mail gravado) é recusado inteiro pelo ato', () => {
    expect(pickLoginEmail(['lixo\natacante@evil.test'])).toBeNull()
    expect(pickLoginEmail(['lixo\natacante@evil.test', 'ana@setes.com.br'])).toBe('ana@setes.com.br')
  })
})

// ======================================================================================================================================
// Parte 2 — o script INTEIRO com o banco dublado (o GROUP_CONCAT da lista emulado exatamente: linhas unidas por '\n')
// ======================================================================================================================================
interface Sup { id: number; active: 'S' | 'N'; mails: string[]; password: string }
let supers: Sup[]
let afterListing: (() => void) | undefined

function installFakeDb(): void {
  mockPool.query.mockImplementation(async (sql: string) => {
    if (/IF\(u\.active = 'S' AND ihu\.active = 'S'/.test(sql)) {
      const rows = supers.map(s => {
        const live = s.mails.filter(m => m.trim() !== '' && !m.includes(String.fromCharCode(10)))   // = TRIM(m.email) <> '' AND INSTR(m.email, CHAR(10)) = 0 (correção do ADV-FG-01)
        return { id: s.id, active: s.active, loginEmails: live.length ? live.join('\n') : null }   // = GROUP_CONCAT(... SEPARATOR '\n')
      })
      afterListing?.()
      return [rows]
    }
    if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: 'setes_setes' }]]
    throw new Error(`SQL inesperado no pool: ${sql}`)
  })
  mockPool.getConnection.mockImplementation(async () => {
    let pending: { id: number; hash: string } | null = null
    return {
      beginTransaction: async () => undefined,
      commit: async () => { if (pending) supers.find(s => s.id === pending!.id)!.password = pending.hash },
      rollback: async () => { pending = null },
      release: () => undefined,
      query: async (sql: string, params: any[] = []) => {
        if (/FROM setes_central\.tb_user WHERE id = \? AND deleted = 'N' FOR UPDATE/.test(sql)) {
          const s = supers.find(x => x.id === params[0])
          return [s ? [{ id: s.id, active: s.active, password: s.password }] : []]
        }
        if (/FROM setes_central\.tb_institution_has_user/.test(sql) && /kind = 'super'/.test(sql)) {
          const s = supers.find(x => x.id === params[0])
          return [s ? [{ active: s.active }] : []]
        }
        if (/FROM setes_central\.tb_entity_has_mailing/.test(sql) && /tb_mailing_group_id = 2/.test(sql)) {
          const s = supers.find(x => x.id === params[0])
          return [(s?.mails ?? []).filter(m => m.trim() !== '').map(email => ({ email }))]   // uma LINHA por e-mail gravado
        }
        if (/^\s*UPDATE setes_central\.tb_user SET password = \?/.test(sql)) {
          pending = { id: Number(params[2]), hash: String(params[0]) }
          return [{ affectedRows: 1 }]
        }
        throw new Error(`SQL inesperado na conexão: ${sql}`)
      },
    }
  })
}

class ExitSignal extends Error { constructor(public code: number | undefined) { super(`process.exit(${code})`) } }
const fmt = (a: unknown[]) => a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')

async function runScript(argv: string[]): Promise<{ out: string[]; err: string[]; exit: number | undefined }> {
  const out: string[] = [], err: string[] = []
  const spies = [
    jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(fmt(a)) }),
    jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(fmt(a)) }),
    jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { err.push(fmt(a)) }),
  ]
  let exit: number | undefined
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code; throw new ExitSignal(code) }) as any)
  const argvBefore = process.argv
  const exitCodeBefore = process.exitCode
  process.argv = ['node', SCRIPT, ...argv]
  let finish!: () => void
  const finished = new Promise<void>(r => { finish = r })
  mockPool.end.mockImplementation(async () => { finish() })
  try {
    jest.isolateModules(() => { require(SCRIPT) })
    await finished
    return { out, err, exit }
  } finally {
    process.argv = argvBefore
    process.exitCode = exitCodeBefore
    exitSpy.mockRestore()
    spies.forEach(s => s.mockRestore())
  }
}
const sentTo = () => mockSent.map(s => s.m.to)
const bannerMask = (out: string[]) => /Senha INICIAL do Super id=\d+ \(([^)]*)\)/.exec(out.join('\n'))?.[1]

describe('ADV-FG D-EA23 — o script: a lista, o ensaio, o alvo e a tela pela MESMA regra do ato', () => {
  beforeEach(() => {
    afterListing = undefined
    mockPool.query.mockReset(); mockPool.getConnection.mockReset(); mockPool.end.mockReset()
    installFakeDb()
  })

  it('[RESISTIU] sem sujeira: ensaio, aviso e tela mostram o mesmo e-mail; o aviso sai a ele', async () => {
    supers = [{ id: 7, active: 'S', mails: ['ana@setes.com.br'], password: 'OLD7' }]
    const run = await runScript(['--vai'])
    expect(run.exit).toBeUndefined()
    expect(sentTo()).toEqual(['ana@setes.com.br'])
    expect(bannerMask(run.out)).toBe('a***@setes.com.br')
  })

  // ADV-FG-01 (MEDIUM — D-EA23 quebrada pela LISTA): `listSuperAccounts` junta os candidatos com GROUP_CONCAT(... SEPARATOR '\n') e o JS
  // os separa por '\n' — o comentário diz "endereço válido nunca a contém", mas um e-mail GRAVADO inválido pode conter (o mesmo dado sujo
  // que a D-EA26 combate: SQL, carga do ERP Desktop). "lixo\natacante@evil.test" vira DOIS candidatos e a lista escolhe o FRAGMENTO
  // "atacante@evil.test" — que o ato (uma linha por e-mail) recusa inteiro, escolhendo "ana@setes.com.br". Efeito no procedimento do Super:
  // o ensaio e a linha da SENHA dizem "Super id=7 (a***@evil.test)" enquanto o aviso foi a ana; e `--email atacante@evil.test` ELEGE o
  // Super 7 (um e-mail que não é login de ninguém) e troca a senha. A D-EA23 promete UMA regra: "o 1º e-mail de login vivo que, APARADO,
  // é um endereço válido".
  it('[CORRIGIDO] ADV-FG-01a: e-mail gravado com quebra de linha — a tela do operador mostra o e-mail que o ato escolheu (o do aviso)', async () => {
    supers = [{ id: 7, active: 'S', mails: ['lixo\natacante@evil.test', 'ana@setes.com.br'], password: 'OLD7' }]
    const dry = await runScript([])
    expect(dry.out.join('\n')).not.toMatch(/evil\.test/)                       // ensaio: o alvo pelo e-mail que o --vai usaria
    mockSent.length = 0
    const run = await runScript(['--vai'])
    expect(sentTo()).toEqual(['ana@setes.com.br'])                             // (o aviso já vai certo — D-EA23 no ato)
    expect(bannerMask(run.out)).toBe('a***@setes.com.br')                      // a linha da SENHA deve dizer o mesmo
  })

  it('[CORRIGIDO] ADV-FG-01b: --email com o FRAGMENTO de um e-mail gravado inválido não elege o Super (não é e-mail de login de ninguém)', async () => {
    supers = [{ id: 7, active: 'S', mails: ['lixo\natacante@evil.test', 'ana@setes.com.br'], password: 'OLD7' }]
    const run = await runScript(['--email', 'atacante@evil.test', '--vai'])
    expect(run.exit).toBe(2)                                                   // recusa: nenhum Super com esse login
    expect(supers[0].password).toBe('OLD7')
  })

  // ADV-FG-02 (LOW — D-EA23, tela): a linha da senha e o log "D-PV46: senha do Super REDEFINIDA" usam o e-mail da LISTA (`target`), não o
  // escolhido SOB a trava (`verdict.loginEmail`). Com o e-mail trocado entre a lista e o ato (o caso que a D-EA23 resolveu para o aviso), o
  // aviso sai ao novo e a tela/log dizem o velho.
  it('[CORRIGIDO] ADV-FG-02: e-mail trocado entre a lista e o ato — a linha da senha diz o e-mail do aviso, não o velho', async () => {
    supers = [{ id: 7, active: 'S', mails: ['velho@setes.com.br'], password: 'OLD7' }]
    afterListing = () => { supers[0].mails = ['novo@setes.com.br'] }
    const run = await runScript(['--vai'])
    expect(sentTo()).toEqual(['novo@setes.com.br'])
    expect(bannerMask(run.out)).toBe('n***@setes.com.br')
  })

  it('[RESISTIU] D-EA26 + D-EA23: único e-mail gravado como lista — ensaio anuncia a recusa e o --vai recusa sem escrita nem envio', async () => {
    supers = [{ id: 7, active: 'S', mails: ['ana@setes.com.br; espiao@evil.test'], password: 'OLD7' }]
    const dry = await runScript([])
    expect(dry.out.join('\n')).toMatch(/SEM E-MAIL DE LOGIN/)
    const run = await runScript(['--vai'])
    expect(run.exit).toBe(2)
    expect(supers[0].password).toBe('OLD7')
    expect(mockSent).toHaveLength(0)
  })
})

// ======================================================================================================================================
// Parte 3 — AO VIVO em schema DESCARTÁVEL: a LISTA real (GROUP_CONCAT) × o ATO real com um e-mail gravado com quebra de linha
// ======================================================================================================================================
const hasEnv = fs.existsSync(path.join(REPO, '.env'))
;(hasEnv ? describe : describe.skip)('ADV-FG D-EA23 — ao vivo (MariaDB do dev, schema descartável; setes_central só lida)', () => {
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  const dotenv = jest.requireActual('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const cfg = () => ({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, timezone: 'Z' as const })
  const PROBE = `setes_eafinal_probe_${Date.now().toString(36)}`
  const rewrite = (sql: string) => sql.replace(/setes_central\./g, `\`${PROBE}\`.`)
  let admin: import('mysql2/promise').Connection
  let before = ''
  const peca = require('../modules/auth/super-password-reset') as typeof import('../modules/auth/super-password-reset')

  const probeConn = (c: import('mysql2/promise').Connection): any => new Proxy(c, {
    get(target, prop, receiver) {
      if (prop === 'query') return async (sql: string, params?: unknown[]) => target.query(rewrite(sql), params as any)
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const fingerprint = async () => JSON.stringify((await admin.query<any[]>(
    'CHECKSUM TABLE setes_central.tb_user, setes_central.tb_institution_has_user, setes_central.tb_mailing, setes_central.tb_entity_has_mailing'))[0])

  beforeAll(async () => {
    admin = await mysql.createConnection(cfg())
    before = await fingerprint()
    await admin.query(`CREATE SCHEMA \`${PROBE}\` DEFAULT CHARACTER SET utf8mb4`)
    for (const t of ['tb_user', 'tb_institution_has_user', 'tb_mailing', 'tb_entity_has_mailing']) {
      await admin.query(`CREATE TABLE \`${PROBE}\`.\`${t}\` LIKE setes_central.\`${t}\``)
    }
    await admin.query(`ALTER TABLE \`${PROBE}\`.tb_user ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    const now = new Date()
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_user (id, password, active, activation_key, created_at, updated_at, deleted) VALUES (?, ?, 'S', NULL, ?, ?, 'N')`,
      [900401, 'HASH900401', now, now])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted) VALUES (1, ?, 'super', 'S', ?, ?, 'N')`,
      [900401, now, now])
    const mail: Array<[number, string]> = [[900411, 'lixo\nalvo-errado@probe.test'], [900412, 'p401@probe.test']]
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_mailing (id, email, created_at, updated_at, deleted) VALUES ?`, [mail.map(([id, e]) => [id, e, now, now, 'N'])])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_entity_has_mailing (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted) VALUES ?`,
      [mail.map(([id]) => [900401, id, 2, now, now, 'N'])])
  }, 60000)

  afterAll(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS \`${PROBE}\``)
      const [left] = await admin.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [PROBE])
      expect(left).toEqual([])
      expect(await fingerprint()).toBe(before)
    } finally {
      await admin.end()
    }
  }, 60000)

  // ADV-FG-01 provado no banco REAL: a coluna aceita a quebra de linha, o GROUP_CONCAT a devolve dentro do texto e a lista escolhe o
  // fragmento; o ato (mesma tabela, uma linha por e-mail) escolhe o outro.
  it('[CORRIGIDO] ADV-FG-01c: a LISTA real e o ATO real escolhem o MESMO e-mail de login (D-EA23)', async () => {
    const listed = (await peca.listSuperAccounts(probeConn(admin))).find(s => s.id === 900401)!
    const c = await mysql.createConnection(cfg())
    let chosen: string | undefined
    try {
      await c.beginTransaction()
      const v = await peca.resetSuperPasswordTx(probeConn(c), 900401, peca.hashInitialPassword(peca.generateInitialPassword()))
      chosen = v.status === 'reset' ? v.loginEmail : undefined
      await c.rollback()                                                         // nada gravado
    } finally { await c.end() }
    expect(chosen).toBe('p401@probe.test')
    expect(listed.loginEmail).toBe(chosen)
  }, 30000)
})
