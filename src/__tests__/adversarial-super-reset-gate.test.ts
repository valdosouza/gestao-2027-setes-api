/// <reference types="jest" />
// GATE ADVERSARIAL da D-RS7/D-RS13 (2026-11-01 — branch `super-reset`): ataca o `scripts/reset-super-password.ts` INTEIRO (rodado no
// processo do jest, com dublê do banco e o MAILER REAL sobre um nodemailer dublado — nenhum e-mail sai, nenhuma linha do `.env` entra)
// e a peça `@modules/auth/super-password-reset`. Parte 3 = prova AO VIVO em SCHEMA DESCARTÁVEL (molde da Parte 2 do
// super-password-reset-d-pv46.test.ts): o alvo deixa de ser Super DURANTE o ato. `setes_central` só é LIDA (impressão digital).
// Os `it.failing` são ACHADOS CONFIRMADOS (vermelhos de propósito): quando o autor corrigir, o jest acusa e o `.failing` vira `it`.
// Achados: ADV-RS13-01 (CORRIGIDO pela D-EA21 — mascarar na mailer), ADV-RS13-02, ADV-RS16-01, ADV-RS7-01 (CORRIGIDOS pelo autor na mesma
// sessão — viraram `it`) e ADV-RS16-02 (semântica fixada — questão ao Valdo, Q-EA22).
import fs from 'fs'
import path from 'path'

// ---- dublês (o prefixo `mock` deixa o jest.mock içado referenciar — o MESMO objeto vale dentro do isolateModules) ------------------
const mockPool = { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() }
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const mockTransport = { sendMail: jest.fn(), verify: jest.fn() }
const mockCreateTransport = jest.fn((_opts?: unknown) => mockTransport)
const mockZoneFor = jest.fn(async (..._a: unknown[]) => 'America/Sao_Paulo')

jest.mock('dotenv/config', () => ({}))                                  // o script nunca carrega o .env real (SMTP real) no jest
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

const REPO = path.join(__dirname, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'reset-super-password.ts')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const addressparser = require('nodemailer/lib/addressparser') as (s: string) => Array<{ address?: string; group?: unknown[] }>

// ---- banco dublado do script ----------------------------------------------------------------------------------------------------
interface Sup { id: number; userActive: 'S' | 'N'; linkActive: 'S' | 'N'; kind: string; email: string | null; password: string }
interface Db { supers: Sup[]; events: string[]; deadlockOnce?: boolean; commitError?: Error; demoteAfterListing?: number }
let db: Db

function md5(v: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
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
      if (db.demoteAfterListing !== undefined) db.supers.find(s => s.id === db.demoteAfterListing)!.kind = 'admin'
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
        if (db.commitError) { const e = db.commitError; db.commitError = undefined; throw e }
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
        if (/FROM setes_central\.tb_entity_has_mailing/.test(sql) && /tb_mailing_group_id = 2/.test(sql)) {   // D-EA20/D-EA23 (sob a trava)
          const s = db.supers.find(x => x.id === params[0])
          return [s?.email && s.email.trim() !== '' ? [{ email: s.email }] : []]
        }
        if (/^\s*UPDATE setes_central\.tb_user SET password = \?/.test(sql)) {
          if (db.deadlockOnce) {
            db.deadlockOnce = false
            db.events.push(`update-deadlock:${params[2]}:${params[0]}`)
            throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
          }
          pending = { id: Number(params[2]), hash: String(params[0]) }
          db.events.push(`update:${params[2]}:${params[0]}`)
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
  const fmt = (a: unknown[]) => a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
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
    return { out, err, exit, exitCode: process.exitCode }
  } finally {
    process.argv = argvBefore
    process.exitCode = exitCodeBefore
    exitSpy.mockRestore()
    spies.forEach(s => s.mockRestore())
  }
}

const PASSWORD_LINE = /^\s{5}([A-Za-z0-9]{16})\s*$/
function printedPasswords(run: Run): string[] {
  return run.out.flatMap(l => l.split('\n')).map(l => PASSWORD_LINE.exec(l)?.[1]).filter((x): x is string => Boolean(x))
}
const mails = () => mockTransport.sendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string; html: string })
const allLogText = () => JSON.stringify([mockLog.info.mock.calls, mockLog.warn.mock.calls, mockLog.error.mock.calls])

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'NODE_ENV'] as const
let envBefore: Record<string, string | undefined>

beforeEach(() => {
  envBefore = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  process.env.SMTP_HOST = 'smtp.adv.test'
  process.env.SMTP_PORT = '587'
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASSWORD
  process.env.SMTP_FROM = 'Setes ERP <nao-responda@adv.test>'
  process.env.NODE_ENV = 'test'
  db = {
    events: [],
    supers: [
      { id: 7, userActive: 'S', linkActive: 'S', kind: 'super', email: 'ana@setes.com.br', password: 'OLD7' },
      { id: 9, userActive: 'S', linkActive: 'S', kind: 'super', email: 'Bia@Setes.com.br', password: 'OLD9' },
      { id: 11, userActive: 'N', linkActive: 'S', kind: 'super', email: 'ivo@setes.com.br', password: 'OLD11' },
    ],
  }
  mockPool.query.mockReset(); mockPool.getConnection.mockReset(); mockPool.end.mockReset()
  installFakeDb()
  mockTransport.sendMail.mockReset().mockImplementation(async () => { db.events.push('mail') })
  mockCreateTransport.mockClear()
  mockZoneFor.mockReset().mockResolvedValue('America/Sao_Paulo')
  mockLog.info.mockClear(); mockLog.warn.mockClear(); mockLog.error.mockClear()
})

afterEach(() => {
  for (const k of ENV_KEYS) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k] }
})

const passwordOf = (id: number) => db.supers.find(s => s.id === id)!.password
const untouched = () => db.supers.every(s => s.password.startsWith('OLD'))

// ======================================================================================================================
// Parte 1 — D-RS7 (alvo): o script inteiro
// ======================================================================================================================
describe('ADV D-RS7 — escolha do alvo pelo script inteiro', () => {
  it('2 Supers ATIVOS sem nome, com --vai: recusa (exit 2), nenhuma transação, nenhum e-mail, a recusa não cita tela', async () => {
    const run = await runScript(['--vai'])
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(/há 2 Supers ATIVOS \(ids 7, 9\).*nomeie o alvo/)
    expect(run.err.join('\n')).not.toMatch(/tela/i)
    expect(mockPool.getConnection).not.toHaveBeenCalled()
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
    expect(printedPasswords(run)).toEqual([])
    expect(untouched()).toBe(true)
  })

  it('--email digitado com CAIXA e espaços: grava SÓ o Super nomeado e o aviso vai ao e-mail GRAVADO (nunca ao texto digitado)', async () => {
    const run = await runScript(['--email', '  BIA@SETES.COM.BR  ', '--vai'])
    expect(run.exit).toBeUndefined()
    const [pw] = printedPasswords(run)
    expect(printedPasswords(run)).toHaveLength(1)                          // impressa UMA vez
    expect(passwordOf(9)).toBe(md5(pw))
    expect(passwordOf(7)).toBe('OLD7')
    expect(mails()).toHaveLength(1)
    expect(mails()[0].to).toBe('Bia@Setes.com.br')                         // o GRAVADO, com a caixa gravada
    // a senha só existe na linha impressa: nem no e-mail, nem no log, nem no stderr
    expect(JSON.stringify(mails())).not.toContain(pw)
    expect(allLogText()).not.toContain(pw)
    expect(run.err.join('\n')).not.toContain(pw)
    expect(run.out.filter(l => l.includes(pw))).toHaveLength(1)
  })

  it('--user-id de Super INATIVO entre ativos, com --vai: recusa sem transação e sem e-mail (o script não reativa)', async () => {
    const run = await runScript(['--user-id', '11', '--vai'])
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(/INATIVO/)
    expect(mockPool.getConnection).not.toHaveBeenCalled()
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
    expect(untouched()).toBe(true)
    expect(db.supers.find(s => s.id === 11)!.userActive).toBe('N')
  })

  it('--email que a COLAÇÃO do banco igualaria (acento) NÃO casa, e dois Supers com o mesmo e-mail (caixa) = recusa — nunca escolhe outro', async () => {
    db.supers[0].email = 'ana@gmail.com'
    let run = await runScript(['--email', 'ana@gmaíl.com', '--vai'])     // utf8mb4_general_ci igualaria; o script não
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(/nenhum Super \(ou mais de um\)/)
    db.supers[1].email = 'ANA@GMAIL.COM'
    run = await runScript(['--email', 'ana@gmail.com', '--vai'])
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(/nenhum Super \(ou mais de um\)/)
    expect(mockPool.getConnection).not.toHaveBeenCalled()
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
    expect(untouched()).toBe(true)
  })

  it.each([
    [['--email', '--vai'], /nenhum Super \(ou mais de um\)/],              // o valor engole o --vai: nunca vira ato
    [['--vai', '--vai'], /argumento repetido/],
    [['--user-id', '7', '--email', 'ana@setes.com.br', '--vai'], /OU --email/],
    [['--user-id', '07', '--vai'], /inteiro positivo/],
    [['--user-id', '1e1', '--vai'], /inteiro positivo/],
    [['--user-id', '٧', '--vai'], /inteiro positivo/],                     // dígito arábico-índico
    [['--email', '   ', '--vai'], /exige o e-mail/],
    [['--VAI'], /argumento desconhecido/],
    [['—vai'], /argumento desconhecido/],                                   // travessão do corretor
  ])('argumentos estranhos %j: recusa sem transação nem e-mail', async (argv, msg) => {
    const run = await runScript(argv as string[])
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(msg as RegExp)
    expect(mockPool.getConnection).not.toHaveBeenCalled()
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
  })

  it('o alvo deixa de ser Super entre a ESCOLHA e o ATO: nada gravado, senha NÃO impressa, nenhum e-mail', async () => {
    db.demoteAfterListing = 7
    const run = await runScript(['--user-id', '7', '--vai'])
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(/deixou de ser Super no meio — nada gravado/)
    expect(db.events).toEqual(['list', 'begin', 'lock', 'link', 'rollback', 'release'])
    expect(printedPasswords(run)).toEqual([])
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
    expect(untouched()).toBe(true)
  })

  it('ensaio (sem --vai): nenhuma conexão de transação, nenhum e-mail, nenhum aviso', async () => {
    db.supers = db.supers.filter(s => s.id !== 9)
    const run = await runScript([])
    expect(run.exit).toBeUndefined()
    expect(run.out.join('\n')).toMatch(/ENSAIO — nada gravado\. Alvo: Super id=7/)
    expect(mockPool.getConnection).not.toHaveBeenCalled()
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
    expect(mockCreateTransport).not.toHaveBeenCalled()
  })
})

// ======================================================================================================================
// Parte 2 — D-RS13 (aviso): o script inteiro, mailer REAL
// ======================================================================================================================
describe('ADV D-RS13 — o aviso pelo script inteiro (mailer real, nodemailer dublado)', () => {
  beforeEach(() => { db.supers = db.supers.filter(s => s.id !== 9) })   // 1 Super ativo: alvo implícito

  it('deadlock na 1ª tentativa: UMA troca, a MESMA senha nas duas tentativas, UM aviso — depois do COMMIT e ANTES da senha (D-EA19)', async () => {
    db.deadlockOnce = true
    let printedBeforeMail = true
    mockTransport.sendMail.mockImplementation(async () => {
      // D-EA19 (Valdo 2026-11-01, "(b) Aviso primeiro"): quando o envio começa, a senha AINDA NÃO está na tela
      printedBeforeMail = (console.log as unknown as jest.Mock).mock.calls
        .some(c => String(c[0]).split('\n').some(l => PASSWORD_LINE.test(l)))
      db.events.push('mail')
    })
    const run = await runScript(['--vai'])
    const [pw] = printedPasswords(run)
    const h = md5(pw)
    expect(db.events).toEqual([
      'list', 'begin', 'lock', 'link', `update-deadlock:7:${h}`, 'rollback', 'release',
      'begin', 'lock', 'link', `update:7:${h}`, 'commit', 'release', 'mail',
    ])
    expect(printedBeforeMail).toBe(false)
    expect(mails()).toHaveLength(1)
    expect(mails()[0].to).toBe('ana@setes.com.br')
    expect(passwordOf(7)).toBe(h)
  })

  it('COMMIT com desfecho incerto (conexão caiu): nenhum aviso e a senha NÃO é impressa (exit 1)', async () => {
    db.commitError = Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' })
    const run = await runScript(['--vai'])
    expect(run.exitCode).toBe(1)
    expect(printedPasswords(run)).toEqual([])
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
  })

  it('SMTP caindo no envio: a senha foi impressa, o aviso falha com log de erro, o script termina com SUCESSO (a troca fica)', async () => {
    mockTransport.sendMail.mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:587'), { code: 'ETIMEDOUT' }))
    const run = await runScript(['--vai'])
    const [pw] = printedPasswords(run)
    expect(passwordOf(7)).toBe(md5(pw))
    expect(run.exit).toBeUndefined()
    expect(run.exitCode).toBeUndefined()
    expect(run.out.join('\n')).toMatch(/Aviso ao Super NÃO enviado \(falha do envio — ver o log\); a senha SEGUE redefinida/)
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringMatching(/D-RS13: falha no envio/), expect.objectContaining({ code: 'ETIMEDOUT' }))
  })

  it('produção sem SMTP: a troca fica, o aviso é "NÃO enviado" (nunca "foi ao log")', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.SMTP_HOST
    const run = await runScript(['--vai'])
    expect(printedPasswords(run)).toHaveLength(1)
    expect(mockCreateTransport).not.toHaveBeenCalled()
    expect(run.out.join('\n')).toMatch(/Aviso ao Super NÃO enviado/)
    expect(run.out.join('\n')).not.toMatch(/o texto foi ao log/)
  })

  it('zona corrompida com HTML/injeção: o aviso cai na zona padrão e nenhum marcador entra no HTML nem no texto', async () => {
    mockZoneFor.mockResolvedValue('<img src=x onerror=alert(1)>')
    await runScript(['--vai'])
    const [m] = mails()
    for (const body of [m.text, m.html]) {
      expect(body).toMatch(/fuso America\/Sao_Paulo/)
      expect(body).not.toMatch(/<img|onerror|<script|href=|https?:\/\//i)
    }
    expect(m.subject).toBe('Setes — a senha da sua conta foi redefinida')
  })

  it('a leitura da zona falha (banco fora no fim): o aviso ainda sai, na zona padrão', async () => {
    mockZoneFor.mockRejectedValue(new Error('banco fora'))
    const run = await runScript(['--vai'])
    expect(mails()).toHaveLength(1)
    expect(mails()[0].text).toMatch(/fuso America\/Sao_Paulo/)
    expect(run.out.join('\n')).toMatch(/Aviso enviado ao e-mail de login do Super \(a\*\*\*@setes\.com\.br\)/)
  })

  // D-EA20 (Valdo 2026-11-01, "(a) Recusar"): antes a troca ficava e só o aviso faltava — a senha nova não servia para entrar
  it('Super sem e-mail de login: RECUSA sem escrita (D-EA20) — nenhuma transação, nenhum envio, nenhuma senha impressa', async () => {
    db.supers[0].email = null
    const run = await runScript(['--vai'])
    expect(run.exit).toBe(2)
    expect(run.err.join('\n')).toMatch(/SEM E-MAIL DE LOGIN — nada gravado/)
    expect(db.events).not.toContain('begin')
    expect(printedPasswords(run)).toEqual([])
    expect(mockTransport.sendMail).not.toHaveBeenCalled()
  })

  it('D-EA20 no ensaio: o alvo SEM e-mail de login é anunciado como recusado (não promete redefinir)', async () => {
    db.supers[0].email = null
    const run = await runScript([])
    expect(run.out.join('\n')).toMatch(/SEM E-MAIL DE LOGIN — o --vai será RECUSADO/)
    expect(run.out.join('\n')).not.toMatch(/Repita com --vai para redefinir a senha/)
  })

  // ---- ACHADOS (vermelhos de propósito) ---------------------------------------------------------------------------------------
  // ADV-RS13-01 (LOW, DATA_EXPOSURE): o script MASCARA o e-mail de login do Super na tela e no seu log (CLAUDE.md: "o LOG registra …
  // o e-mail mascarado"), mas a `@shared/mailer` loga o destinatário INTEIRO (`Email enviado` {to}; no modo dev `SMTP não configurado`
  // {to}) — e o logger da casa é o console: o e-mail inteiro sai no MESMO terminal, logo abaixo da linha mascarada.
  // CORRIGIDO pela D-EA21 (Valdo 2026-11-01, "(a) Mascarar em todos"): a `@shared/mailer` loga o destinatário MASCARADO
  it('ADV-RS13-01: nenhum log do ato traz o e-mail de login INTEIRO do Super (só o mascarado)', async () => {
    await runScript(['--vai'])
    expect(mails()).toHaveLength(1)
    expect(allLogText()).not.toContain('ana@setes.com.br')
  })

  // ADV-RS13-02 (LOW, e-mail ao endereço errado): o aviso confia no e-mail GRAVADO como LISTA de endereços — o nodemailer separa vírgula/
  // ponto e vírgula/nome de exibição. Um e-mail de login gravado fora da porta validada (SQL, carga do legado; o cadastro valida com
  // z.email()) com "a@x, b@y" manda o aviso de segurança do Super também a um terceiro. Dado real hoje: 0 linhas assim (conferido).
  // CORRIGIDO (autor, mesma sessão): o aviso só sai para UM endereço válido pelo validador do cadastro (z.email) — senão 'failed'
  it('ADV-RS13-02: e-mail de login gravado com 2 endereços — o aviso vai a NO MÁXIMO um destinatário (ou não sai)', async () => {
    db.supers[0].email = 'ana@setes.com.br, intruso@evil.test'
    await runScript(['--vai'])
    for (const m of mails()) expect(addressparser(m.to).filter(a => a.address)).toHaveLength(1)
  })
})

// ======================================================================================================================
// Parte 2b — ensaio × ato (D-RS16): a pré-visualização tem que dizer o que o --vai fará
// ======================================================================================================================
describe('ADV D-RS16 — o ensaio promete o que o ato recusa', () => {
  // ADV-RS16-01 (LOW, UX/procedimento): com o alvo NOMEADO inativo o ensaio diz "Repita com --vai para redefinir a senha", e o --vai
  // recusa ("está INATIVO — reative-o pela tela de Usuários (outro Super)"); com 0 Super ativo a recusa sem nome manda "nomeie o alvo",
  // e não existe "outro Super" para reativar — o operador anda em círculo (o CLAUDE.md diz que só sai por SQL manual — limite conhecido).
  // CORRIGIDO (autor, mesma sessão): o ensaio diz INATIVO + "o --vai será RECUSADO" com a saída real (inactiveTargetExit)
  it('ADV-RS16-01: o ensaio do alvo INATIVO avisa que o --vai será recusado (não promete redefinir)', async () => {
    const run = await runScript(['--user-id', '11'])
    expect(run.out.join('\n')).toMatch(/INATIV/)
    expect(run.out.join('\n')).not.toMatch(/Repita com --vai para redefinir a senha/)
  })
})

// ======================================================================================================================
// Parte 3 — AO VIVO em schema descartável: o alvo deixa de ser Super DURANTE o ato (entre a trava e o COMMIT)
// ======================================================================================================================
const hasEnv = fs.existsSync(path.join(REPO, '.env'))
;(hasEnv ? describe : describe.skip)('ADV — vínculo mudando DURANTE o ato (MariaDB do dev, schema descartável; setes_central só lida)', () => {
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  const dotenv = jest.requireActual('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const cfg = () => ({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, timezone: 'Z' as const })
  const PROBE = `setes_rs7adv_probe_${Date.now().toString(36)}`
  let admin: import('mysql2/promise').Connection
  let before = ''
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  /** Conexão real com `setes_central.` trocado pelo descartável no TEXTO do SQL; `release` = fechar; [afterLink] roda depois da leitura do vínculo. */
  const probeConn = (c: import('mysql2/promise').Connection, afterLink?: () => Promise<void>): any => new Proxy(c, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sql: string, params?: unknown[]) => {
          const r = await target.query(sql.replace(/setes_central\./g, `\`${PROBE}\`.`), params as any)
          if (afterLink && /tb_institution_has_user/.test(sql) && /kind = 'super'/.test(sql)) await afterLink()
          return r
        }
      }
      if (prop === 'release') return () => { void target.end() }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const fingerprint = async () => {
    const [u] = await admin.query<any[]>(
      `SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT(id, ':', COALESCE(password, ''), ':', COALESCE(updated_at, '')) ORDER BY id)) AS h FROM setes_central.tb_user`)
    const [l] = await admin.query<any[]>(
      `SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT(tb_institution_id, ':', tb_user_id, ':', kind, ':', active, ':', COALESCE(updated_at, ''))
         ORDER BY tb_institution_id, tb_user_id)) AS h FROM setes_central.tb_institution_has_user`)
    return `${u[0].n}:${u[0].h}|${l[0].n}:${l[0].h}`
  }
  const state = async (id: number) => {
    const [[u]] = await admin.query<any[]>(`SELECT password FROM \`${PROBE}\`.tb_user WHERE id = ?`, [id]) as any
    const [[l]] = await admin.query<any[]>(`SELECT kind, active FROM \`${PROBE}\`.tb_institution_has_user WHERE tb_user_id = ? AND tb_institution_id = 1`, [id]) as any
    return { password: u.password, kind: l.kind, active: l.active }
  }

  /** O ato real (`resetSuperPasswordTx`) com um `setInstitutionLinks` REAL disparado logo depois da leitura do vínculo. */
  async function raceResetAgainstLinks(userId: number, links: Array<{ institutionId: number; kind: string }>) {
    const { resetSuperPasswordTx, hashInitialPassword, generateInitialPassword } =
      require('../modules/auth/super-password-reset') as typeof import('../modules/auth/super-password-reset')
    const { setInstitutionLinks } = require('../modules/users/users.repository') as typeof import('../modules/users/users.repository')
    const c1 = await mysql.createConnection(cfg())
    const c2 = await mysql.createConnection(cfg())
    await c2.query('SET SESSION innodb_lock_wait_timeout = 20')
    mockPool.getConnection.mockReset().mockImplementationOnce(async () => probeConn(c2))
    const hash = hashInitialPassword(generateInitialPassword())
    let concurrent: Promise<void> | undefined
    let finishedWhileOpen = false
    try {
      await c1.beginTransaction()
      const verdict = await resetSuperPasswordTx(probeConn(c1, async () => {
        let done = false
        concurrent = setInstitutionLinks(userId, links as any).finally(() => { done = true })
        await sleep(800)
        finishedWhileOpen = done                                              // o Super concorrente gravou com o ato ainda aberto?
      }), userId, hash)
      if (verdict.status === 'reset') await c1.commit(); else await c1.rollback()
      await concurrent
      return { verdict, hash, finishedWhileOpen, after: await state(userId) }
    } finally {
      await c1.end().catch(() => undefined)
    }
  }

  beforeAll(async () => {
    admin = await mysql.createConnection(cfg())
    before = await fingerprint()
    await admin.query(`CREATE SCHEMA \`${PROBE}\` DEFAULT CHARACTER SET utf8mb4`)
    // D-EA20: o ato confere o e-mail de login SOB a trava — a cópia leva as tabelas de e-mail (sem FK, sem dado de setes_central)
    for (const t of ['tb_user', 'tb_institution_has_user', 'tb_mailing', 'tb_entity_has_mailing']) {
      await admin.query(`CREATE TABLE \`${PROBE}\`.\`${t}\` LIKE setes_central.\`${t}\``)
    }
    await admin.query(`ALTER TABLE \`${PROBE}\`.tb_user ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    // a FK REAL de setes_central (fk_ihu_to_user) — o CREATE TABLE … LIKE não a copia, e é ELA que serializa o INSERT do vínculo
    await admin.query(`ALTER TABLE \`${PROBE}\`.tb_institution_has_user
                         ADD CONSTRAINT fk_probe_ihu_user FOREIGN KEY (tb_user_id) REFERENCES \`${PROBE}\`.tb_user (id)`)
    const now = new Date()
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_user (id, password, active, activation_key, created_at, updated_at, deleted) VALUES ?`, [[
      [900201, 'HASH1', 'S', null, now, now, 'N'], [900202, 'HASH2', 'S', null, now, now, 'N'],
    ]])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted) VALUES ?`, [[
      [1, 900201, 'super', 'S', now, now, 'N'], [1, 900202, 'super', 'S', now, now, 'N'],
    ]])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_mailing (id, email, created_at, updated_at, deleted) VALUES ?`, [[
      [900201, 'super1@probe.test', now, now, 'N'], [900202, 'super2@probe.test', now, now, 'N'],
    ]])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_entity_has_mailing (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted) VALUES ?`, [[
      [900201, 900201, 2, now, now, 'N'], [900202, 900202, 2, now, now, 'N'],
    ]])
  }, 30000)

  afterAll(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS \`${PROBE}\``)
      expect(await fingerprint()).toBe(before)                                 // setes_central intacta
    } finally {
      await admin.end()
    }
  }, 30000)

  it('a cópia tem a FK REAL do vínculo para o usuário (a prova não depende de tabela sem FK)', async () => {
    const [fk] = await admin.query<any[]>(
      `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_institution_has_user' AND COLUMN_NAME = 'tb_user_id' AND REFERENCED_TABLE_NAME = 'tb_user'`,
      [PROBE])
    expect(fk.map((r: any) => r.CONSTRAINT_NAME)).toEqual(['fk_probe_ihu_user'])
  })

  // ADV-RS16-02 (LOW, RACE_CONDITION só de ORDEM REAL — ANTERIOR a esta entrega; nem `resetSuperPasswordTx` nem `setInstitutionLinks`
  // mudaram): o `setInstitutionLinks` (Super, `PUT …/institutions`) muda `kind`/`active` do vínculo SEM a trava da linha do usuário.
  // Vínculo que JÁ existe vai pelo ramo ON DUPLICATE KEY UPDATE — a duplicata é achada no índice clusterizado ANTES da inserção no índice
  // da FK, então a FK fk_ihu_to_user NÃO consulta o pai e nada espera; `links: []` (o DTO aceita) é só UPDATE. PROVADO: o ato lê "super
  // ativo", o Super concorrente rebaixa a admin (ou revoga tudo) e CONFIRMA com o ato aberto, e o ato grava a senha de quem, no COMMIT, já é
  // admin. O desfecho é IGUAL à ordem serial "redefine → rebaixa" (a leitura do vínculo precede a escrita do outro: sem ciclo, serializável)
  // — só a ordem no relógio inverte (o rebaixamento terminou antes). Estes testes FIXAM a semântica de hoje (conhecimento negativo); se o
  // Valdo decidir a ordem estrita (o `setInstitutionLinks` toma a trava da linha do usuário como 1º statement), eles mudam: o concorrente
  // passa a esperar o ato (`finishedWhileOpen` false) — o desfecho final fica o mesmo.
  it('ADV-RS16-02a (semântica de hoje): rebaixar o Super a admin DURANTE o ato confirma com o ato aberto; desfecho = "redefine → rebaixa"', async () => {
    const r = await raceResetAgainstLinks(900201, [{ institutionId: 1, kind: 'admin' }])
    expect(r.verdict.status).toBe('reset')
    expect(r.finishedWhileOpen).toBe(true)
    expect(r.after).toEqual({ password: r.hash, kind: 'admin', active: 'S' })
  }, 60000)

  it('ADV-RS16-02b (semântica de hoje): revogar TODOS os vínculos (links: []) DURANTE o ato idem; desfecho = "redefine → revoga"', async () => {
    const r = await raceResetAgainstLinks(900202, [])
    expect(r.verdict.status).toBe('reset')
    expect(r.finishedWhileOpen).toBe(true)
    expect(r.after).toEqual({ password: r.hash, kind: 'super', active: 'N' })
  }, 60000)
})

// ======================================================================================================================
// Parte 4 — a peça pura: bordas do pickSuperTarget que o script não alcança
// ======================================================================================================================
describe('ADV D-RS7 — pickSuperTarget nas bordas', () => {
  const { pickSuperTarget } = require('../modules/auth/super-password-reset') as typeof import('../modules/auth/super-password-reset')
  const A = { id: 7, active: 'S', loginEmail: 'ana@setes.com.br' }
  const B = { id: 9, active: 'S', loginEmail: 'bia@setes.com.br' }

  it('a mesma conta repetida na lista conta como 2 ativos → recusa (nunca "escolhe" a duplicata)', () => {
    expect('refusal' in pickSuperTarget([A, { ...A }], {})).toBe(true)
  })

  it('--user-id NaN/0/negativo (chamada direta da peça) nunca casa', () => {
    for (const userId of [NaN, 0, -7]) expect('refusal' in pickSuperTarget([A, B], { userId })).toBe(true)
  })

  // ADV-RS7-01 (LOW, latente): a peça EXPORTADA casa `email: ''` com o Super SEM e-mail de login (`(null ?? '') === ''`) e o devolve
  // como alvo. Hoje inalcançável (o parseArgs recusa `--email` vazio), mas "a regra mora na peça" — o próximo chamador (a A2 leva o
  // script para a auth-api) herda o defeito. Correção natural: e-mail vazio/só espaços = recusa na própria peça.
  // CORRIGIDO (autor, mesma sessão): e-mail vazio/só espaços = recusa na própria peça; loginEmail null nunca casa
  it('ADV-RS7-01: --email vazio na PEÇA não casa o Super sem e-mail de login', () => {
    expect('refusal' in pickSuperTarget([{ id: 3, active: 'S', loginEmail: null }, A], { email: '' })).toBe(true)
  })
})
