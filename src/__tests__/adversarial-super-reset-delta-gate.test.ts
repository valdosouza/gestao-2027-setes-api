/// <reference types="jest" />
// GATE ADVERSARIAL DO DELTA (2026-11-01 — branch `super-reset`, depois da 1ª rodada em adversarial-super-reset-gate.test.ts): ataca o que
// entrou DEPOIS — D-EA19 (o aviso ao Super sai ANTES de a senha aparecer), D-EA20 (Super sem e-mail de login recusado sem escrita, ato
// reconfere sob a trava), D-EA21 (todo e-mail que vai ao LOG sai mascarado — `maskEmail`/`mailErrorForLog` da `@shared/mailer`) e as
// correções da 1ª rodada. Partes:
//   1. o script INTEIRO no processo do jest (banco dublado, mailer REAL sobre nodemailer dublado — nenhum e-mail sai);
//   2. o script/peça com o nodemailer REAL contra um SMTP LOCAL de teste (127.0.0.1, porta efêmera — nada sai da máquina);
//   3. AO VIVO em SCHEMA DESCARTÁVEL (MariaDB do dev; `setes_central` só LIDA — CHECKSUM antes/depois; DROP no fim);
//   4. as rotas públicas de auth com um erro REAL do mysql2 (consulta a um schema que NÃO existe — nada é criado).
// Convenção da casa: `it` = [RESISTIU] (a promessa se cumpre); `achado` (= `it.failing`) = [ACHADO] (a asserção SEGURA que o código atual
// quebra — jest marca verde enquanto o achado existir; corrigido, o jest acusa e o `achado` vira `it`).
// Não edita produção nem os testes existentes. O `.env` real NUNCA entra no processo (dotenv dublado): nenhum SMTP real é tocado.
import fs from 'fs'
import net from 'net'
import path from 'path'
import util from 'util'

// ---- dublês (prefixo `mock` para o jest.mock içado) -------------------------------------------------------------------------------
const mockPool = { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() }
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const mockTransport = { sendMail: jest.fn(), verify: jest.fn() }
const mockCreateTransport = jest.fn((_opts?: any): any => mockTransport)
const mockZoneFor = jest.fn(async (..._a: unknown[]) => 'America/Sao_Paulo')

jest.mock('dotenv/config', () => ({}))                                   // o script nunca carrega o .env real
jest.mock('dotenv', () => {                                              // o app.ts também não (SMTP real fora do processo)
  const actual = jest.requireActual('dotenv')
  const config = () => ({ parsed: {} })
  return { __esModule: true, ...actual, config, default: { ...actual, config } }
})
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: mockPool }))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: mockLog }))
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: (o: unknown) => mockCreateTransport(o) },
  createTransport: (o: unknown) => mockCreateTransport(o),
}))
jest.mock('../shared/db/counters', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/db/counters'),
  detectLockWaitSupport: jest.fn(async () => true),
  isLockWaitSupported: () => true,
}))
jest.mock('../shared/time-zone', () => {
  const actual = jest.requireActual('../shared/time-zone')
  return { __esModule: true, ...actual, institutionZoneFor: (...a: unknown[]) => mockZoneFor(...a) }
})
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: () => 'REF00000', recordCrash: jest.fn().mockResolvedValue(undefined),
}))

const REPO = path.join(__dirname, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'reset-super-password.ts')
// ADV_SHOW_ACHADOS=1 roda os ACHADOS como `it` — o jest mostra a falha REAL de cada um (confere que falha pelo motivo certo, nunca por montagem).
const achado: jest.It = process.env.ADV_SHOW_ACHADOS ? it : it.failing

// ---- linha do tempo: a ORDEM entre o desfecho do aviso e a senha na tela (D-EA19) --------------------------------------------------
let timeline: string[] = []
const fmt = (a: unknown[]) => a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')

// ---- banco dublado do script --------------------------------------------------------------------------------------------------------
interface Sup { id: number; userActive: 'S' | 'N'; linkActive: 'S' | 'N'; kind: string; email: string | null; password: string }
interface Db { supers: Sup[]; events: string[]; deadlocks?: number; afterListing?: () => void }
let db: Db

function md5(v: string): string {
  return (require('../shared/auth/password') as typeof import('../shared/auth/password')).md5Password(v)
}

function installFakeDb(): void {
  mockPool.query.mockImplementation(async (sql: string) => {
    if (/IF\(u\.active = 'S' AND ihu\.active = 'S'/.test(sql)) {
      db.events.push('list')
      const rows = db.supers.filter(s => s.kind === 'super')
        // D-EA23: a lista devolve os CANDIDATOS (vivos, não brancos — o SQL corta o branco); quem escolhe é a peça
        .map(s => ({ id: s.id, active: s.userActive === 'S' && s.linkActive === 'S' ? 'S' : 'N',
          loginEmails: s.email && s.email.trim() !== '' ? s.email : null }))
      db.afterListing?.()
      return [rows]
    }
    if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: 'setes_setes' }]]
    throw new Error(`SQL inesperado no pool: ${sql}`)
  })
  mockPool.getConnection.mockImplementation(async () => {
    let pending: { id: number; hash: string } | null = null
    return {
      beginTransaction: async () => { db.events.push('begin') },
      commit: async () => {
        if (pending) db.supers.find(s => s.id === pending!.id)!.password = pending.hash
        db.events.push('commit')
      },
      rollback: async () => { pending = null; db.events.push('rollback') },
      release: () => { db.events.push('release') },
      query: async (sql: string, params: any[] = []) => {
        if (/FROM setes_central\.tb_user WHERE id = \? AND deleted = 'N' FOR UPDATE/.test(sql)) {
          db.events.push('lock')
          const s = db.supers.find(x => x.id === params[0])
          return [s ? [{ id: s.id, active: s.userActive, password: s.password }] : []]
        }
        if (/FROM setes_central\.tb_institution_has_user/.test(sql) && /kind = 'super'/.test(sql)) {
          db.events.push('link')
          const s = db.supers.find(x => x.id === params[0] && x.kind === 'super')
          return [s ? [{ active: s.linkActive }] : []]
        }
        if (/FROM setes_central\.tb_entity_has_mailing/.test(sql) && /tb_mailing_group_id = 2/.test(sql)) {   // D-EA20, sob a trava
          db.events.push('mail-check')
          const s = db.supers.find(x => x.id === params[0])
          return [s?.email && s.email.trim() !== '' ? [{ email: s.email }] : []]                           // = TRIM(m.email) <> '' (D-EA23)
        }
        if (/^\s*UPDATE setes_central\.tb_user SET password = \?/.test(sql)) {
          if (db.deadlocks && db.deadlocks > 0) {
            db.deadlocks--
            db.events.push('update-deadlock')
            throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
          }
          pending = { id: Number(params[2]), hash: String(params[0]) }
          db.events.push(`update:${params[2]}`)
          return [{ affectedRows: 1 }]
        }
        throw new Error(`SQL inesperado na conexão: ${sql}`)
      },
    }
  })
}

class ExitSignal extends Error { constructor(public code: number | undefined) { super(`process.exit(${code})`) } }
interface Run { out: string[]; err: string[]; exit: number | undefined; exitCode: number | string | undefined | null }

/** Roda o script REAL no processo do jest com [argv]; espera o `finally(() => pool.end())` dele. */
async function runScript(argv: string[]): Promise<Run> {
  const out: string[] = [], err: string[] = []
  const spies = [
    jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(fmt(a)); timeline.push(`out:${fmt(a)}`) }),
    jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(fmt(a)); timeline.push(`err:${fmt(a)}`) }),
    jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { err.push(fmt(a)); timeline.push(`err:${fmt(a)}`) }),
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
    return { out, err, exit, exitCode: process.exitCode }
  } finally {
    process.argv = argvBefore
    process.exitCode = exitCodeBefore
    exitSpy.mockRestore()
    spies.forEach(s => s.mockRestore())
  }
}

const PASSWORD_LINE = /^\s{5}([A-Za-z0-9]{16})\s*$/
const isPasswordEntry = (e: string) => e.startsWith('out:') && e.slice(4).split('\n').some(l => PASSWORD_LINE.test(l))
function printedPasswords(run: Run): string[] {
  return run.out.flatMap(l => l.split('\n')).map(l => PASSWORD_LINE.exec(l)?.[1]).filter((x): x is string => Boolean(x))
}
const mails = () => mockTransport.sendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string; html: string })
const allLogText = () => JSON.stringify([mockLog.info.mock.calls, mockLog.warn.mock.calls, mockLog.error.mock.calls])

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'NODE_ENV'] as const
let envBefore: Record<string, string | undefined>

beforeEach(() => {
  envBefore = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  process.env.SMTP_HOST = 'smtp.adv.test'                                  // configurado, mas o transporte é o dublê
  process.env.SMTP_PORT = '587'
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASSWORD
  process.env.SMTP_FROM = 'Setes ERP <nao-responda@adv.test>'
  process.env.NODE_ENV = 'test'
  timeline = []
  db = {
    events: [],
    supers: [
      { id: 7, userActive: 'S', linkActive: 'S', kind: 'super', email: 'ana@setes.com.br', password: 'OLD7' },
      { id: 11, userActive: 'N', linkActive: 'S', kind: 'super', email: 'ivo@setes.com.br', password: 'OLD11' },
    ],
  }
  mockPool.query.mockReset(); mockPool.getConnection.mockReset(); mockPool.end.mockReset()
  installFakeDb()
  mockTransport.sendMail.mockReset().mockImplementation(async (m: any) => { timeline.push(`mail:${m.to}`); db.events.push('mail') })
  mockCreateTransport.mockReset().mockImplementation(() => mockTransport)
  mockZoneFor.mockReset().mockResolvedValue('America/Sao_Paulo')
  for (const level of ['info', 'warn', 'error'] as const) {
    mockLog[level].mockReset().mockImplementation((msg: string, meta?: unknown) => { timeline.push(`log:${msg} ${JSON.stringify(meta ?? '')}`) })
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k] }
})

const passwordOf = (id: number) => db.supers.find(s => s.id === id)!.password
const untouched = () => db.supers.every(s => s.password.startsWith('OLD'))

// ---- SMTP LOCAL de teste (127.0.0.1) — o nodemailer REAL fala com ele; nada sai da máquina -----------------------------------------
type SmtpBehavior = 'accept' | 'reject-rcpt' | 'trickle-ehlo'
interface Smtp { port: number; transcript: string[]; close: () => Promise<void> }

async function startSmtp(behavior: SmtpBehavior): Promise<Smtp> {
  const sockets = new Set<net.Socket>()
  const timers = new Set<NodeJS.Timeout>()
  const transcript: string[] = []
  const server = net.createServer(sock => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => undefined)
    sock.setEncoding('utf8')
    sock.write('220 probe.local ESMTP adv\r\n')
    let buf = ''
    let inData = false
    sock.on('data', (chunk: string) => {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (inData) { if (line === '.') { inData = false; sock.write('250 2.0.0 Ok: queued\r\n') } continue }
        transcript.push(line)
        const cmd = line.slice(0, 4).toUpperCase()
        if (cmd === 'EHLO' || cmd === 'HELO') {
          if (behavior === 'trickle-ehlo') {
            // resposta MULTILINHA que nunca termina: uma linha de continuação a cada 5 s (sempre antes do teto de inatividade de 30 s)
            sock.write('250-probe.local\r\n')
            const t = setInterval(() => { if (!sock.destroyed) sock.write('250-X-ADV-TRICKLE\r\n') }, 5000)
            timers.add(t)
          } else {
            sock.write('250-probe.local\r\n250 SIZE 1000000\r\n')
          }
        } else if (cmd === 'MAIL') sock.write('250 2.1.0 Ok\r\n')
        else if (cmd === 'RCPT') {
          const addr = /<([^>]*)>/.exec(line)?.[1] ?? ''
          sock.write(behavior === 'reject-rcpt'
            ? `550 5.1.1 <${addr}>: Recipient address rejected: User unknown in virtual mailbox table\r\n`
            : '250 2.1.5 Ok\r\n')
        } else if (cmd === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n') }
        else if (cmd === 'QUIT') { sock.write('221 2.0.0 Bye\r\n'); sock.end() }
        else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 2.0.0 Ok\r\n')
        else sock.write('502 5.5.2 Error: command not recognized\r\n')
      }
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as net.AddressInfo).port
  return {
    port, transcript,
    close: async () => {
      timers.forEach(t => clearInterval(t))
      sockets.forEach(s => s.destroy())
      await new Promise<void>(r => server.close(() => r()))
    },
  }
}

/** O mailer passa a usar o nodemailer REAL — só para o SMTP LOCAL (qualquer outro host = erro: nenhum e-mail sai da máquina). */
function useLocalSmtp(port: number): void {
  process.env.SMTP_HOST = '127.0.0.1'
  process.env.SMTP_PORT = String(port)                                    // porta efêmera: sem SSL implícito e sem STARTTLS exigido
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASSWORD
  mockCreateTransport.mockImplementation((o: any) => {
    if (o?.host !== '127.0.0.1') throw new Error(`transporte REAL só para o SMTP local do teste (pedido: ${o?.host})`)
    return (jest.requireActual('nodemailer') as typeof import('nodemailer')).createTransport(o)
  })
}

// ======================================================================================================================================
// Parte 1 — D-EA19: o aviso PRECEDE a senha em TODO desfecho; um aviso por troca gravada
// ======================================================================================================================================
describe('ADV D-EA19 — a senha só aparece DEPOIS do desfecho do aviso (script inteiro)', () => {
  it.each([
    ['sent — SMTP aceita', () => undefined, 'Aviso enviado ao e-mail de login do Super'],
    ['failed — SMTP recusa com o endereço na mensagem', () => {
      mockTransport.sendMail.mockImplementation(async (m: any) => {
        timeline.push(`mail:${m.to}`)
        throw Object.assign(new Error(`Can't send mail - all recipients were rejected: 550 5.1.1 <${m.to}>: Recipient address rejected`),
          { code: 'EENVELOPE', responseCode: 550, response: `550 5.1.1 <${m.to}>`, rejected: [m.to] })
      })
    }, 'Aviso ao Super NÃO enviado (falha do envio'],
    ['logged — dev sem SMTP', () => { delete process.env.SMTP_HOST }, 'SMTP ausente — o texto foi só ao log'],
    ['failed — produção sem SMTP', () => { delete process.env.SMTP_HOST; process.env.NODE_ENV = 'production' }, 'Aviso ao Super NÃO enviado'],
    // (o caso "e-mail GRAVADO que não é um endereço único" saiu desta tabela: pela D-EA23 ele é RECUSADO antes da transação — teste abaixo)
  ] as Array<[string, () => void, string]>)('%s: UMA tentativa de aviso, depois a linha do desfecho, só então a senha (uma vez)', async (_n, arrange, outcome) => {
    arrange()
    const run = await runScript(['--vai'])
    expect(run.exit).toBeUndefined()
    expect(printedPasswords(run)).toHaveLength(1)
    const pwIdx = timeline.findIndex(isPasswordEntry)
    const noticeIdx = timeline.findIndex(e => e.startsWith('mail:') || /^log:(D-RS13|SMTP não configurado)/.test(e))
    const outcomeIdx = timeline.findIndex(e => e.startsWith('out:') && e.includes(outcome))
    expect(noticeIdx).toBeGreaterThanOrEqual(0)
    expect(outcomeIdx).toBeGreaterThan(noticeIdx)
    expect(pwIdx).toBeGreaterThan(outcomeIdx)
    expect(timeline.filter(e => e.startsWith('mail:')).length).toBeLessThanOrEqual(1)
    expect(passwordOf(7)).toBe(md5(printedPasswords(run)[0]))
  })

  it('deadlock 2× e depois sucesso: 3 transações, UMA troca, UM aviso, a MESMA senha nas três tentativas', async () => {
    db.deadlocks = 2
    const run = await runScript(['--vai'])
    expect(db.events.filter(e => e === 'begin')).toHaveLength(3)
    expect(db.events.filter(e => e === 'commit')).toHaveLength(1)
    expect(db.events.filter(e => e === 'mail')).toHaveLength(1)
    expect(db.events.indexOf('mail')).toBeGreaterThan(db.events.indexOf('commit'))
    expect(printedPasswords(run)).toHaveLength(1)
    expect(passwordOf(7)).toBe(md5(printedPasswords(run)[0]))
  })

  it('deadlock nas 3 tentativas: falha (exit 1), NADA gravado, nenhum aviso, nenhuma senha impressa (aviso nunca sem troca)', async () => {
    db.deadlocks = 3
    const run = await runScript(['--vai'])
    expect(run.exitCode).toBe(1)
    expect(db.events).not.toContain('commit')
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
    expect(printedPasswords(run)).toEqual([])
    expect(untouched()).toBe(true)
  })

  // ADV-EA19-01 (LOW, robustez): a peça promete "NUNCA lança" — mas o `catch` dela chama `mailErrorForLog(err)`, que faz `String(err)`;
  // uma rejeição que não vira texto (objeto sem protótipo) faz o PRÓPRIO catch lançar → `main` rejeita → "✗ falha", exit 1, e a senha
  // JÁ GRAVADA nunca é impressa (o mesmo desfecho do Ctrl+C, mas por um erro de log). Gatilho exótico: o nodemailer rejeita com Error.
  // CORRIGIDO (autor, mesma sessão): `mailErrorForLog` nunca lança e o catch da peça blinda o próprio log
  it('ADV-EA19-01: rejeição do envio que não vira texto — a troca fica e a senha AINDA aparece (a peça nunca lança)', async () => {
    mockTransport.sendMail.mockImplementation(async () => { throw Object.create(null) })
    const run = await runScript(['--vai'])
    expect(passwordOf(7)).not.toBe('OLD7')                                 // a troca foi gravada…
    expect(printedPasswords(run)).toHaveLength(1)                          // …e a senha tem de aparecer
  })
})

// ======================================================================================================================================
// Parte 1b — D-EA20: Super sem e-mail de login
// ======================================================================================================================================
describe('ADV D-EA20 — Super sem e-mail de login (script inteiro, banco dublado)', () => {
  it('e-mail gravado VAZIO (\'\', não null): recusa ANTES da transação — nada gravado, nenhum aviso, nenhuma senha', async () => {
    db.supers[0].email = ''
    const run = await runScript(['--vai'])
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(/SEM E-MAIL DE LOGIN — nada gravado/)
    expect(db.events).not.toContain('begin')
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
    expect(printedPasswords(run)).toEqual([])
  })

  // D-EA23 (Valdo 2026-11-01, "(a) Regra única"): a LISTA já aplica a regra do ato — e-mail só de espaços ou gravado como LISTA não é
  // e-mail de login; o --vai recusa ANTES da transação (antes, o só-espaços passava o pré-filtro e o ato recusava; a lista gravava e o aviso
  // dava 'failed'). A recusa SOB a trava segue provada no dublê do ato e ao vivo (super-password-reset-d-pv46.test.ts).
  it.each([
    ['só de espaços', '   '],
    ['gravado como LISTA de endereços', 'ana@setes.com.br; bia@setes.com.br'],
  ])('e-mail de login %s: o --vai RECUSA antes da transação (D-EA23) — nada gravado, nenhum aviso, nenhuma senha', async (_n, email) => {
    db.supers[0].email = email
    const run = await runScript(['--vai'])
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(/SEM E-MAIL DE LOGIN — nada gravado/)
    expect(db.events).toEqual(['list'])
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
    expect(printedPasswords(run)).toEqual([])
    expect(untouched()).toBe(true)
  })

  // ADV-EA20-02 (LOW, UX/procedimento — mesma classe do ADV-RS16-01): o ENSAIO julga "sem e-mail" por `!loginEmail` e o ATO por
  // `TRIM(m.email) <> ''` — com o e-mail só de espaços o ensaio PROMETE ("Repita com --vai para redefinir a senha") e o --vai recusa.
  // CORRIGIDO pela D-EA23 (Valdo 2026-11-01, "(a) Regra única"): a lista, o ensaio e o ato usam a MESMA peça `pickLoginEmail`
  it('ADV-EA20-02: e-mail só de espaços — o ENSAIO avisa que o --vai será recusado (não promete redefinir)', async () => {
    db.supers[0].email = '   '
    const run = await runScript([])
    expect(run.out.join('\n')).not.toMatch(/Repita com --vai para redefinir a senha/)
    expect(run.out.join('\n')).toMatch(/SEM E-MAIL DE LOGIN — o --vai será RECUSADO/)
  })

  it('e-mail REMOVIDO entre a LISTA e o ATO: o ato reconfere sob a trava e recusa — nada gravado, nenhum aviso, nenhuma senha', async () => {
    db.afterListing = () => { db.supers[0].email = null }
    const run = await runScript(['--vai'])
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(/SEM E-MAIL DE LOGIN — nada gravado/)
    expect(db.events).toContain('rollback')
    expect(db.events).not.toContain('commit')
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
    expect(printedPasswords(run)).toEqual([])
    expect(untouched()).toBe(true)
  })
})

// ======================================================================================================================================
// Parte 1c — D-EA21 pelo script: nenhum log/saída com o endereço inteiro
// ======================================================================================================================================
describe('ADV D-EA21 — o script não põe e-mail inteiro no log', () => {
  it('SMTP recusando com o endereço (e o de terceiro) na mensagem: o log leva só os mascarados; o transporte recebeu o endereço inteiro', async () => {
    mockTransport.sendMail.mockImplementation(async (m: any) => {
      timeline.push(`mail:${m.to}`)
      throw Object.assign(new Error(`Message failed: 550 5.7.1 <${m.to}> rejected; forwarded copy to Fulano.Silva+cobranca@Cliente.COM.br failed`),
        { code: 'EMESSAGE', responseCode: 550, response: `550 5.7.1 <${m.to}>`, rejected: [m.to] })
    })
    await runScript(['--vai'])
    expect(mails()[0].to).toBe('ana@setes.com.br')
    expect(allLogText()).not.toMatch(/ana@setes|fulano\.silva|Fulano\.Silva/i)
    expect(allLogText()).toContain('a***@setes.com.br')
    expect(allLogText()).toContain('F***@Cliente.COM.br')
  })

  // ADV-EA21-01 (LOW, DATA_EXPOSURE): `maskEmail` mascara só o que vem ANTES do 1º "@" e devolve o resto INTEIRO — um e-mail de login
  // gravado em forma de lista ("a@x, b@y" — o mesmo dado do ADV-RS13-02, fora da porta validada) sai com o 2º endereço em claro no log
  // da recusa do aviso E na listagem do operador. Dado real hoje: 0 linhas assim (conferido).
  // CORRIGIDO (autor, mesma sessão): `maskEmail` mascara TODO endereço do valor
  it('ADV-EA21-01: e-mail gravado em forma de lista — nem o log nem a tela mostram o 2º endereço inteiro', async () => {
    db.supers[0].email = 'ana@setes.com.br, intruso@evil.test'
    const run = await runScript(['--vai'])
    expect(mockTransport.sendMail).not.toHaveBeenCalled()                 // ADV-RS13-02 segue fechado
    expect(allLogText()).not.toContain('intruso@evil.test')
    expect(run.out.join('\n')).not.toContain('intruso@evil.test')
  })
})

// ======================================================================================================================================
// Parte 2 — a peça de máscara nas bordas (D-EA21) — mailer REAL
// ======================================================================================================================================
describe('ADV D-EA21 — maskEmail / mailErrorForLog nas bordas', () => {
  const { maskEmail, mailErrorForLog } = require('../shared/mailer/mailer') as typeof import('../shared/mailer/mailer')

  it.each([
    ['+tag e caixa alta', 'Fulano.Tag+Cobranca2026@Setes.COM.br', 'F***@Setes.COM.br'],
    ['IDN no local e no domínio', 'joão.ÇÃO@exêmplo.com.br', 'j***@exêmplo.com.br'],
    ['local com caracteres especiais permitidos', "o'brien.x!#$%&*=?^_`{|}~-@setes.com.br", 'o***@setes.com.br'],
  ])('%s: o endereço some, fica 1ª letra + domínio — em TODA moldura que o SMTP usa', (_n, addr, masked) => {
    const frames = [`<${addr}>`, `RCPT TO:<${addr}>`, `(${addr})`, `[${addr}]`, `"${addr}"`, `'${addr}'`, `${addr};x`, `${addr},`,
      `to=${addr}`, `${addr}.`, `\r\n${addr}\r\n`, `mailto:${addr}`]
    for (const f of frames) {
      const out = mailErrorForLog(new Error(`550 5.1.1 ${f} Recipient address rejected`)).message
      expect(out).not.toContain(addr)
      expect(out).toContain(masked.slice(1))                               // o domínio (e a máscara) ficam
    }
  })

  it('várias pessoas na mesma mensagem: todas mascaradas; `response`/`rejected`/`stack` nunca saem', () => {
    const err = Object.assign(new Error('rejected: <a1.x@d.com> <b2.y@d.com>, c3.z@e.org; d4.w@f.net'),
      { code: 'EENVELOPE', responseCode: 550, response: '550 <a1.x@d.com>', rejected: ['a1.x@d.com', 'b2.y@d.com'] })
    const out = mailErrorForLog(err)
    expect(JSON.stringify(out)).not.toMatch(/a1\.x@|b2\.y@|c3\.z@|d4\.w@/)
    expect(Object.keys(out)).toEqual(['code', 'responseCode', 'message'])
  })

  it('a máscara do destinatário: maiúsculas, +tag e IDN viram 1ª letra + domínio', () => {
    expect(maskEmail('VALDO+X@SETES.COM.BR')).toBe('V***@SETES.COM.BR')
    expect(maskEmail('joão@exemplo.com.br')).toBe('j***@exemplo.com.br')
  })

  // ADV-EA21-01 (raiz): a máscara do DESTINATÁRIO (`maskEmail`) não mascara um 2º endereço no mesmo texto; `maskEmailsIn` (a do erro)
  // mascara — duas regras para a mesma promessa.
  it('ADV-EA21-01 (raiz): maskEmail de um texto com DOIS endereços não deixa o 2º inteiro', () => {
    expect(maskEmail('ana@setes.com.br, intruso@evil.test')).not.toContain('intruso@evil.test')
  })
})

// ======================================================================================================================================
// Parte 2b — o nodemailer REAL contra um SMTP LOCAL (127.0.0.1): o erro de verdade e a espera de verdade
// ======================================================================================================================================
describe('ADV D-EA21/D-EA19 — nodemailer REAL contra SMTP local de teste', () => {
  let smtp: Smtp | undefined
  afterEach(async () => { await smtp?.close(); smtp = undefined })

  it('SMTP recusa o RCPT ecoando o endereço (erro REAL do nodemailer): o script loga só o mascarado e a senha aparece depois', async () => {
    smtp = await startSmtp('reject-rcpt')
    useLocalSmtp(smtp.port)
    const run = await runScript(['--vai'])
    expect(smtp.transcript).toContain('RCPT TO:<ana@setes.com.br>')        // o transporte recebeu o endereço INTEIRO (a máscara não quebrou o envio)
    expect(run.out.join('\n')).toMatch(/Aviso ao Super NÃO enviado \(falha do envio/)
    expect(printedPasswords(run)).toHaveLength(1)
    const failure = mockLog.error.mock.calls.find(c => /D-RS13: falha no envio/.test(String(c[0])))
    expect(failure).toBeDefined()
    expect(failure![1]).toEqual(expect.objectContaining({ code: 'EENVELOPE', responseCode: 550 }))
    expect(String((failure![1] as any).message)).toContain('<a***@setes.com.br>')   // o eco do servidor estava lá — e saiu mascarado
    expect(allLogText()).not.toContain('ana@setes.com.br')
  }, 30000)

  it('SMTP aceita: "sent", o servidor recebeu o endereço inteiro, o log "Email enviado" só o mascarado', async () => {
    smtp = await startSmtp('accept')
    useLocalSmtp(smtp.port)
    const run = await runScript(['--vai'])
    expect(smtp.transcript).toContain('RCPT TO:<ana@setes.com.br>')
    expect(run.out.join('\n')).toMatch(/Aviso enviado ao e-mail de login do Super \(a\*\*\*@setes\.com\.br\)/)
    expect(mockLog.info).toHaveBeenCalledWith('Email enviado', expect.objectContaining({ to: 'a***@setes.com.br' }))
    expect(allLogText()).not.toContain('ana@setes.com.br')
  }, 30000)

  // ADV-EA19-02 (LOW, disponibilidade do procedimento): o script promete "até ~1 min" e o comentário "espera limitada pelos tetos do SMTP
  // (15/15/30 s)" — mas o teto de 30 s do nodemailer é de INATIVIDADE e a resposta MULTILINHA só termina na linha sem "-": um servidor
  // (ou quem está no meio, antes do STARTTLS) que pinga uma linha de continuação a cada < 30 s prende o aviso SEM FIM — a senha, já
  // gravada, não aparece; Ctrl+C e rodar de novo dá o mesmo. PROVADO: aos 62 s o aviso segue pendente e a senha não saiu.
  // CORRIGIDO pela D-EA24 (Valdo 2026-11-01, "(a) Teto de 60 s"): teto TOTAL de 60 s no aviso — estourado, "NÃO CONFIRMADO" e a senha
  // aparece; o envio segue em segundo plano e o desfecho tardio vai ao log
  it('ADV-EA19-02: SMTP que pinga a resposta — o aviso termina dentro do teto de 60 s e a senha aparece', async () => {
    smtp = await startSmtp('trickle-ehlo')
    useLocalSmtp(smtp.port)
    const running = runScript(['--vai'])
    try {
      await new Promise(r => setTimeout(r, 62_000))
      expect(timeline.some(e => e.includes('Enviando o aviso ao Super ANTES de mostrar a senha'))).toBe(true)
      expect(timeline.some(e => e.includes('NÃO CONFIRMADO em 60 s'))).toBe(true)
      expect(timeline.some(isPasswordEntry)).toBe(true)                    // a promessa: em 60 s a senha está na tela
    } finally {
      await smtp.close()                                                     // derruba o servidor: o envio tardio falha (vai ao log)
      smtp = undefined
      const run = await running
      expect(printedPasswords(run)).toHaveLength(1)
    }
  }, 120000)
})

// ======================================================================================================================================
// Parte 3 — AO VIVO em schema DESCARTÁVEL: o predicado da LISTA × do ATO × do AVISO
// ======================================================================================================================================
const hasEnv = fs.existsSync(path.join(REPO, '.env'))
;(hasEnv ? describe : describe.skip)('ADV D-EA20 — ao vivo (MariaDB do dev, schema descartável; setes_central só lida)', () => {
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  const dotenv = jest.requireActual('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const cfg = () => ({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, timezone: 'Z' as const })
  const PROBE = `setes_eadelta_probe_${Date.now().toString(36)}`
  const rewrite = (sql: string) => sql.replace(/setes_central\./g, `\`${PROBE}\`.`)
  let admin: import('mysql2/promise').Connection
  let before = ''
  const peca = require('../modules/auth/super-password-reset') as typeof import('../modules/auth/super-password-reset')
  const authRepo = require('../modules/auth/auth.repository') as typeof import('../modules/auth/auth.repository')

  const probeConn = (c: import('mysql2/promise').Connection, afterMailCheck?: () => Promise<void>): any => new Proxy(c, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sql: string, params?: unknown[]) => {
          const r = await target.query(rewrite(sql), params as any)
          if (afterMailCheck && /tb_entity_has_mailing/.test(sql) && /TRIM\(m\.email\)/.test(sql)) await afterMailCheck()
          return r
        }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const fingerprint = async () => {
    const [rows] = await admin.query<any[]>(
      'CHECKSUM TABLE setes_central.tb_user, setes_central.tb_institution_has_user, setes_central.tb_mailing, setes_central.tb_entity_has_mailing')
    return JSON.stringify(rows)
  }
  /** O ATO real numa conexão própria (commit/rollback como o script). */
  async function act(userId: number, afterMailCheck?: () => Promise<void>) {
    const c = await mysql.createConnection(cfg())
    try {
      await c.beginTransaction()
      const hash = peca.hashInitialPassword(peca.generateInitialPassword())
      const v = await peca.resetSuperPasswordTx(probeConn(c, afterMailCheck), userId, hash)
      if (v.status === 'reset') await c.commit(); else await c.rollback()
      return { v, hash }
    } finally { await c.end() }
  }
  const passwordIn = async (id: number) => ((await admin.query<any[]>(`SELECT password FROM \`${PROBE}\`.tb_user WHERE id = ?`, [id]))[0] as any[])[0].password
  const superById = async (id: number) => (await peca.listSuperAccounts(probeConn(admin))).find(s => s.id === id)!

  beforeAll(async () => {
    admin = await mysql.createConnection(cfg())
    before = await fingerprint()
    await admin.query(`CREATE SCHEMA \`${PROBE}\` DEFAULT CHARACTER SET utf8mb4`)
    for (const t of ['tb_user', 'tb_institution_has_user', 'tb_mailing', 'tb_entity_has_mailing']) {
      await admin.query(`CREATE TABLE \`${PROBE}\`.\`${t}\` LIKE setes_central.\`${t}\``)   // sem FK, sem dado
    }
    await admin.query(`ALTER TABLE \`${PROBE}\`.tb_user ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    const now = new Date()
    const ids = [900301, 900302, 900303, 900304, 900306, 900307, 900308]
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_user (id, password, active, activation_key, created_at, updated_at, deleted) VALUES ?`,
      [ids.map(id => [id, `HASH${id}`, 'S', null, now, now, 'N'])])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted) VALUES ?`,
      [ids.map(id => [1, id, 'super', 'S', now, now, 'N'])])
    // [mailing id, e-mail, mailing.deleted, entity, grupo, vínculo.deleted]
    const mail: Array<[number, string, string, number, number, string]> = [
      [900311, '   ', 'N', 900301, 2, 'N'],                    // 900301: 1º (menor id) só de espaços…
      [900312, 'p301@probe.test', 'N', 900301, 2, 'N'],        //         …2º válido (o login entra por ele)
      [900321, 'p302@probe.test ', 'N', 900302, 2, 'N'],       // 900302: espaço no FIM (PAD SPACE: o login casa)
      [900331, 'p303@probe.test', 'N', 900303, 2, 'S'],        // 900303: vínculo de login EXCLUÍDO…
      [900332, 'p303b@probe.test', 'N', 900303, 1, 'N'],       //         …e um e-mail VIVO de outro grupo
      [900341, 'p304@probe.test', 'S', 900304, 2, 'N'],        // 900304: e-mail (tb_mailing) EXCLUÍDO com vínculo vivo
      [900361, 'p306@probe.test', 'N', 900306, 2, 'N'],        // 900306: válido (removido entre a lista e o ato / durante o ato)
      [900371, 'p307old@probe.test', 'N', 900307, 2, 'N'],     // 900307: trocado por SQL entre a lista e o ato
      [900381, 'p308old@probe.test', 'S', 900308, 2, 'N'],     // 900308: 2 e-mails de login, o de menor id EXCLUÍDO…
      [900382, 'p308@probe.test', 'N', 900308, 2, 'N'],        //         …e o vivo
    ]
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_mailing (id, email, created_at, updated_at, deleted) VALUES ?`,
      [mail.map(([id, email, del]) => [id, email, now, now, del])])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_entity_has_mailing (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted) VALUES ?`,
      [mail.map(([id, , , ent, grp, del]) => [ent, id, grp, now, now, del])])
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => admin.query(rewrite(sql), params as any))   // findUserByEmail
  }, 60000)

  afterAll(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS \`${PROBE}\``)
      const [left] = await admin.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [PROBE])
      expect(left).toEqual([])
      expect(await fingerprint()).toBe(before)                                // setes_central intacta
    } finally {
      await admin.end()
    }
  }, 60000)

  beforeEach(() => { mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => admin.query(rewrite(sql), params as any)) })

  it('[RESISTIU] e-mail de login excluído (vínculo OU tb_mailing) e e-mail só de outro grupo: lista sem e-mail e o ato recusa sem escrita', async () => {
    for (const id of [900303, 900304]) {
      expect((await superById(id)).loginEmail).toBeNull()
      const { v } = await act(id)
      expect(v).toEqual({ status: 'no-login-email', userId: id })
      expect(await passwordIn(id)).toBe(`HASH${id}`)
    }
  }, 30000)

  it('[RESISTIU] 2 e-mails de login, o de menor id EXCLUÍDO: a lista, o ato e o aviso usam o VIVO', async () => {
    const target = await superById(900308)
    expect(target.loginEmail).toBe('p308@probe.test')
    const { v } = await act(900308)
    expect(v.status).toBe('reset')
    expect(await peca.sendSuperResetNotice(target, new Date(), 'America/Sao_Paulo')).toBe('sent')
    expect(mails().map(m => m.to)).toEqual(['p308@probe.test'])
  }, 30000)

  it('[RESISTIU] e-mail REMOVIDO entre a LISTA e o ATO (SQL): o ato vê a remoção (a leitura nasce depois da trava) e recusa', async () => {
    const target = await superById(900306)
    expect(target.loginEmail).toBe('p306@probe.test')
    await admin.query(`UPDATE \`${PROBE}\`.tb_entity_has_mailing SET deleted = 'S' WHERE tb_entity_id = 900306 AND tb_mailing_group_id = 2`)
    try {
      const { v } = await act(900306)
      expect(v).toEqual({ status: 'no-login-email', userId: 900306 })
      expect(await passwordIn(900306)).toBe('HASH900306')
    } finally {
      await admin.query(`UPDATE \`${PROBE}\`.tb_entity_has_mailing SET deleted = 'N' WHERE tb_entity_id = 900306 AND tb_mailing_group_id = 2`)
    }
  }, 30000)

  // Semântica de hoje (conhecimento negativo — mesma classe da D-EA22, "limite conhecido", ADV-RS16-02): a conferência do e-mail é LEITURA
  // CONSISTENTE, sem trava; quem exclui o vínculo de login DURANTE o ato (só por SQL — D-UC1: pela tela o e-mail de login nunca muda) não
  // espera, e o ato grava. Desfecho = a ordem serial "redefine → remove o e-mail". Se a ordem estrita for decidida, este teste muda.
  it('[SEMÂNTICA] e-mail removido DURANTE o ato (depois da conferência, antes do COMMIT): o ato grava; o desfecho = "redefine → remove"', async () => {
    let finishedWhileOpen = false
    const { v, hash } = await act(900306, async () => {
      await admin.query(`UPDATE \`${PROBE}\`.tb_entity_has_mailing SET deleted = 'S' WHERE tb_entity_id = 900306 AND tb_mailing_group_id = 2`)
      finishedWhileOpen = true
    })
    expect(v.status).toBe('reset')
    expect(finishedWhileOpen).toBe(true)
    expect(await passwordIn(900306)).toBe(hash)
    expect((await superById(900306)).loginEmail).toBeNull()
  }, 30000)

  // ADV-EA20-01 (LOW, latente — 0 linhas assim hoje, conferido; o cadastro valida com z.email): TRÊS predicados para "o e-mail de login
  // do Super" — a LISTA (`ORDER BY m.id LIMIT 1`, sem filtro de branco, lida FORA da trava) escolhe o DESTINO do aviso; o ATO (sob a trava)
  // só confere que EXISTE um não-branco (`TRIM(m.email) <> ''`); o AVISO exige um endereço válido (`z.email`, sem aparar). Quando divergem,
  // o ato GRAVA e o aviso deterministicamente NÃO sai (ou sai ao e-mail velho) — exatamente o "troca sem aviso" que a D-EA20 quis recusar.
  // CORRIGIDOS pela D-EA23 (Valdo 2026-11-01, "(a) Regra única"): a lista e o ato escolhem pela MESMA peça `pickLoginEmail` (1º e-mail de
  // login VÁLIDO, aparado), o ato devolve o escolhido SOB a trava e o aviso vai a ele (o script monta `{ ...target, loginEmail: v.loginEmail }`)
  it('ADV-EA20-01a: 1º e-mail de login só de espaços + 2º válido — a lista e o ato escolhem o 2º e o aviso sai a ele', async () => {
    const target = await superById(900301)
    expect(target.loginEmail).toBe('p301@probe.test')                         // a lista pula o branco
    const { v, hash } = await act(900301)
    expect(v).toEqual({ status: 'reset', userId: 900301, loginEmail: 'p301@probe.test' })
    const login = await authRepo.findUserByEmail('p301@probe.test')
    expect(login?.id).toBe(900301)                                               // o Super ENTRA com a senha nova…
    expect(login?.password).toBe(hash)
    if (v.status !== 'reset') throw new Error('o ato devia gravar')
    expect(await peca.sendSuperResetNotice({ ...target, loginEmail: v.loginEmail }, new Date(), 'America/Sao_Paulo')).toBe('sent')
    expect(mails().map(m => m.to)).toEqual(['p301@probe.test'])                 // …e o aviso sai ao e-mail pelo qual o login entra
  }, 30000)

  it('ADV-EA20-01b: e-mail de login com espaço no FIM — escolhido APARADO; o aviso sai', async () => {
    const target = await superById(900302)
    expect(target.loginEmail).toBe('p302@probe.test')
    const { v, hash } = await act(900302)
    expect(v).toEqual({ status: 'reset', userId: 900302, loginEmail: 'p302@probe.test' })
    const login = await authRepo.findUserByEmail('p302@probe.test')             // PAD SPACE: o login casa sem o espaço
    expect(login?.id).toBe(900302)
    expect(login?.password).toBe(hash)
    if (v.status !== 'reset') throw new Error('o ato devia gravar')
    expect(await peca.sendSuperResetNotice({ ...target, loginEmail: v.loginEmail }, new Date(), 'America/Sao_Paulo')).toBe('sent')
    expect(mails().map(m => m.to)).toEqual(['p302@probe.test'])
  }, 30000)

  it('ADV-EA20-01c: e-mail de login TROCADO por SQL entre a lista e o ato — o aviso vai ao e-mail escolhido SOB a trava, não ao velho', async () => {
    const target = await superById(900307)
    expect(target.loginEmail).toBe('p307old@probe.test')
    await admin.query(`UPDATE \`${PROBE}\`.tb_entity_has_mailing SET deleted = 'S' WHERE tb_entity_id = 900307 AND tb_mailing_id = 900371`)
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_mailing (id, email, created_at, updated_at, deleted) VALUES (900372, 'p307new@probe.test', NOW(), NOW(), 'N')`)
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_entity_has_mailing (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted)
                       VALUES (900307, 900372, 2, NOW(), NOW(), 'N')`)
    const { v } = await act(900307)
    expect(v).toEqual({ status: 'reset', userId: 900307, loginEmail: 'p307new@probe.test' })
    if (v.status !== 'reset') throw new Error('o ato devia gravar')
    await peca.sendSuperResetNotice({ ...target, loginEmail: v.loginEmail }, new Date(), 'America/Sao_Paulo')
    expect(mails().map(m => m.to)).toEqual(['p307new@probe.test'])
  }, 30000)

  // D-EA28 (Valdo 2026-11-04, "(a) Limite conhecido" — Q-EA28 do gate socrático do delta final): a troca do e-mail de login pela tela
  // (`syncLoginEmail`, módulo users) não toma a trava da linha do usuário; se ela confirma DEPOIS de o ato ler o e-mail e ANTES do COMMIT,
  // o ato grava e o aviso vai ao e-mail que o ato LEU (o velho). Mesma família e mesma razão da D-EA22: o desfecho é o de uma ordem serial
  // válida ("redefine → troca o e-mail"), nada escala e a senha nunca vai a ninguém. SEMÂNTICA FIXADA — se a ordem estrita for decidida, este
  // teste muda (a troca teria de esperar o ato).
  it('[SEMÂNTICA D-EA28] e-mail de login TROCADO durante o ato: o ato grava e o aviso vai ao e-mail que o ato leu', async () => {
    const before = (await superById(900307)).loginEmail as string
    let finishedWhileOpen = false
    const { v, hash } = await act(900307, async () => {
      await admin.query(`UPDATE \`${PROBE}\`.tb_entity_has_mailing SET deleted = 'S' WHERE tb_entity_id = 900307 AND tb_mailing_group_id = 2`)
      await admin.query(`INSERT INTO \`${PROBE}\`.tb_mailing (id, email, created_at, updated_at, deleted) VALUES (900373, 'p307newer@probe.test', NOW(), NOW(), 'N')`)
      await admin.query(`INSERT INTO \`${PROBE}\`.tb_entity_has_mailing (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted)
                         VALUES (900307, 900373, 2, NOW(), NOW(), 'N')`)
      finishedWhileOpen = true
    })
    expect(finishedWhileOpen).toBe(true)                                         // a troca NÃO esperou o ato
    expect(v).toEqual({ status: 'reset', userId: 900307, loginEmail: before })   // o ato ficou com o e-mail que leu
    expect(await passwordIn(900307)).toBe(hash)
    expect((await superById(900307)).loginEmail).toBe('p307newer@probe.test')    // depois do COMMIT, o login é o novo
    if (v.status !== 'reset') throw new Error('o ato devia gravar')
    await peca.sendSuperResetNotice({ ...(await superById(900307)), loginEmail: v.loginEmail }, new Date(), 'America/Sao_Paulo')
    expect(mails().map(m => m.to)).toEqual([before])                             // o aviso foi ao e-mail velho — o limite conhecido
  }, 30000)
})

// ======================================================================================================================================
// Parte 4 — D-EA21 nas rotas públicas de auth: o `err` CRU do mysql2 (com `sql` formatado) vai ao log
// ======================================================================================================================================
;(hasEnv ? describe : describe.skip)('ADV D-EA21 — erro REAL do mysql2 nas rotas públicas de senha/login', () => {
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  const dotenv = jest.requireActual('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const ABSENT = `setes_absent_eadelta_${Date.now().toString(36)}`        // NUNCA criado: a consulta falha no servidor, nada é escrito
  let conn: import('mysql2/promise').Connection
  let app: any
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const request = require('supertest') as typeof import('supertest')

  beforeAll(async () => {
    conn = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD })
    app = (require('../app') as { default: any }).default
    ;(require('../modules/auth/auth.service') as typeof import('../modules/auth/auth.service')).setPasswordResetResponseFloor(0)
  }, 60000)
  afterAll(async () => {
    const [left] = await conn.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [ABSENT])
    expect(left).toEqual([])
    await conn.end()
  })
  beforeEach(() => {
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) =>
      conn.query(sql.replace(/setes_central\./g, `\`${ABSENT}\`.`), params as any))
  })

  // ADV-EA21-02 (LOW, DATA_EXPOSURE — anterior ao delta, mas dentro da promessa da D-EA21 "todo e-mail que vai ao LOG sai mascarado"):
  // o `fail()` de auth.routes loga `{ err }` CRU; o erro do mysql2 carrega `sql` com os parâmetros FORMATADOS (o próprio alarmNeutral do
  // service já documenta isso) — com o banco falhando na busca da conta, o e-mail digitado (de qualquer pessoa) sai INTEIRO no log do
  // servidor, nas três rotas públicas. PROVADO com um erro REAL do MariaDB.
  // CORRIGIDO (autor, mesma sessão): o `fail()` das rotas de auth loga só código, errno e mensagem mascarada (sem o `sql`)
  it.each([
    ['/auth/login', { email: 'vitima.real@cliente.com.br', password: 'qualquer' }],
    ['/auth/recovery-password', { email: 'vitima.real@cliente.com.br' }],
    ['/auth/change-password', { email: 'vitima.real@cliente.com.br', code: '123456', newPassword: 'Nova#Senha2026' }],
  ])('ADV-EA21-02: %s com o banco falhando — o log não traz o e-mail digitado inteiro', async (route, body) => {
    const res = await request(app).post(route as string).send(body as object)
    expect(res.status).toBe(500)
    const rendered = mockLog.error.mock.calls.map(c => util.format(...(c as [string, ...unknown[]]))).join('\n')
    expect(rendered).toMatch(/Erro em auth\//)
    expect(rendered).not.toContain('vitima.real@cliente.com.br')
  }, 30000)
})
