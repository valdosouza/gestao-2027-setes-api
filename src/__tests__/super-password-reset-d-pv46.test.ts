/// <reference types="jest" />
// D-PV46 (Valdo, 2026-10-20; executada 2026-10-21 — prompt_privilegios_interfaces.md §13.10): senha perdida do SUPER = procedimento
// do OPERADOR (`scripts/reset-super-password.ts`, núcleo em `@modules/auth/super-password-reset`). Só o Super (vínculo 'super' na
// institution da Setes, vivo e ativo) tem a senha redefinida; qualquer outra conta é recusada SEM escrita; a gravação é pela MESMA
// peça do fluxo normal (`updatePassword`: hash da casa + activation_key limpa + updated_at) sob a trava da linha do usuário.
// Parte 1: dublê de conexão (sem banco). Parte 2: SCHEMA DESCARTÁVEL no MariaDB do dev (cópia vazia das 4 tabelas, usuários
// sintéticos 9xxxxx), apagado no fim — roda quando há `.env` na raiz do repo (sem ele, pula com aviso); `setes_central` só é LIDA
// (impressão digital antes/depois). O ensaio do script (sem `--vai`) é executado contra o banco real: só leitura.
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/mailer/mailer', () => ({
  __esModule: true, ...jest.requireActual('../shared/mailer/mailer'),   // maskEmail / mailErrorForLog reais (D-EA21)
  sendMail: jest.fn(), isMailerConfigured: jest.fn(() => true), isProduction: jest.fn(() => false),
}))

import {
  listSuperAccounts, resetSuperPasswordTx, generateInitialPassword, hashInitialPassword, maskEmail,
  INITIAL_PASSWORD_ALPHABET, INITIAL_PASSWORD_LENGTH, pickSuperTarget, SuperAccount, sendSuperResetNotice, inactiveTargetExit, pickLoginEmail,
  superResetNoticeText, wallTimeInZone, setesInstitutionZone, SUPER_RESET_NOTICE_SUBJECT, SUPER_NOTICE_CAP_MS,
} from '../modules/auth/super-password-reset'
import { md5Password } from '../shared/auth/password'
import * as mailer from '../shared/mailer/mailer'
import * as timeZone from '../shared/time-zone'
import logger from '../shared/logger/logger'

const REPO = path.join(__dirname, '..', '..')

// ---- Parte 1: a peça, com dublê de conexão -----------------------------------------------------------------------------------
describe('D-PV46 — a peça do reset do Super (dublê)', () => {
  interface World {
    user?: { id: number; active: string; password: string | null }; superLink: boolean; linkActive?: string; noLoginEmail?: boolean
    /** D-EA23: os e-mails de login vivos e não brancos, na ordem do id (o padrão é um válido) */
    emails?: string[]
  }
  function conn(world: World) {
    const sql: string[] = []
    const query = jest.fn(async (q: string, params: any[] = []) => {
      sql.push(q)
      if (/FROM setes_central\.tb_user WHERE id = \? AND deleted = 'N' FOR UPDATE/.test(q)) {
        return [world.user ? [{ id: world.user.id, active: world.user.active, password: world.user.password }] : []]
      }
      if (/FROM setes_central\.tb_institution_has_user/.test(q) && /kind = 'super'/.test(q)) {
        expect(params).toEqual([world.user?.id ?? params[0], 1])          // só a institution da Setes
        return [world.superLink ? [{ active: world.linkActive ?? 'S' }] : []]
      }
      if (/FROM setes_central\.tb_entity_has_mailing/.test(q) && /tb_mailing_group_id = 2/.test(q)) {   // D-EA20/D-EA23
        return [world.noLoginEmail ? [] : (world.emails ?? ['super7@probe.test']).map(email => ({ email }))]
      }
      if (/UPDATE setes_central\.tb_user SET password = \?, password_set_at = \?, activation_key = NULL/.test(q)) {
        world.user!.password = params[0]
        return [{ affectedRows: 1 }]
      }
      throw new Error(`SQL inesperado: ${q}`)
    })
    return { c: { query } as any, sql }
  }
  const HASH = md5Password('qualquer')

  it('Super ativo: grava pela peça do fluxo normal (senha + activation_key = NULL + updated_at) depois da trava e do vínculo', async () => {
    const world: World = { user: { id: 7, active: 'S', password: 'OLD' }, superLink: true }
    const { c, sql } = conn(world)
    await expect(resetSuperPasswordTx(c, 7, HASH)).resolves.toEqual({ status: 'reset', userId: 7, loginEmail: 'super7@probe.test' })
    expect(world.user!.password).toBe(HASH)
    expect(sql[0]).toMatch(/FOR UPDATE/)                                   // 1º statement = a trava do usuário (regra 12)
    expect(sql[1]).toMatch(/kind = 'super'/)
    expect(sql[2]).toMatch(/tb_entity_has_mailing/)                        // D-EA20: o e-mail de login conferido SOB a trava
    // D-EA7: o script define a senha pela MESMA peça — o instante T vai junto (as sessões anteriores do Super caem)
    expect(sql[3]).toMatch(/UPDATE setes_central\.tb_user SET password = \?, password_set_at = \?, activation_key = NULL, updated_at = NOW\(\)/)
  })

  it('D-EA23: o ato escolhe SOB a trava o 1º e-mail de login VÁLIDO (aparado) e o devolve; sem nenhum válido, recusa sem escrita', async () => {
    for (const [emails, chosen] of [
      [['   ', 'Ana@Setes.com.br'], 'Ana@Setes.com.br'],                    // 1º em branco (o SQL já corta, a peça confere de novo)
      [['ana@setes.com.br '], 'ana@setes.com.br'],                          // espaço no fim: devolvido aparado
      [['a@x.test, b@y.test', 'ana@setes.com.br'], 'ana@setes.com.br'],     // 1º gravado como lista: pula para o 1º válido
      [['semarroba', 'lista@a; b@c'], null],                                // nenhum válido
    ] as const) {
      const world: World = { user: { id: 7, active: 'S', password: 'OLD' }, superLink: true, emails: [...emails] }
      const { c } = conn(world)
      const v = await resetSuperPasswordTx(c, 7, HASH)
      if (chosen === null) {
        expect(v).toEqual({ status: 'no-login-email', userId: 7 })
        expect(world.user!.password).toBe('OLD')
      } else {
        expect(v).toEqual({ status: 'reset', userId: 7, loginEmail: chosen })
      }
    }
  })

  it('D-EA23: a peça pickLoginEmail é a regra única (1º válido aparado; nenhum = null)', () => {
    expect(pickLoginEmail(['  ', null, 'x', ' b@c.test ', 'd@e.test'])).toBe('b@c.test')
    expect(pickLoginEmail([])).toBeNull()
    expect(pickLoginEmail(['a@x, b@y'])).toBeNull()
  })

  it('D-EA20: Super ativo SEM e-mail de login → recusa `no-login-email` SEM escrita (a senha nova não serviria para entrar)', async () => {
    const world: World = { user: { id: 7, active: 'S', password: 'OLD' }, superLink: true, noLoginEmail: true }
    const { c, sql } = conn(world)
    await expect(resetSuperPasswordTx(c, 7, HASH)).resolves.toEqual({ status: 'no-login-email', userId: 7 })
    expect(world.user!.password).toBe('OLD')
    expect(sql.some(q => /^\s*UPDATE/.test(q))).toBe(false)
  })

  it('admin/user (sem vínculo super na Setes): recusa SEM escrita', async () => {
    const world: World = { user: { id: 8, active: 'S', password: 'OLD' }, superLink: false }
    const { c, sql } = conn(world)
    await expect(resetSuperPasswordTx(c, 8, HASH)).resolves.toEqual({ status: 'not-super', userId: 8 })
    expect(world.user!.password).toBe('OLD')
    expect(sql.some(q => /^\s*UPDATE/.test(q))).toBe(false)              // (o `FOR UPDATE` da trava não é escrita)
  })

  it('conta inexistente/excluída: a MESMA recusa (not-super), sem consultar o vínculo', async () => {
    const { c, sql } = conn({ superLink: true })
    await expect(resetSuperPasswordTx(c, 999, HASH)).resolves.toEqual({ status: 'not-super', userId: 999 })
    expect(sql).toHaveLength(1)
  })

  it('Super INATIVO: recusa sem escrita (reativar é ato pela tela, não deste script)', async () => {
    const world: World = { user: { id: 7, active: 'N', password: 'OLD' }, superLink: true }
    const { c } = conn(world)
    await expect(resetSuperPasswordTx(c, 7, HASH)).resolves.toEqual({ status: 'inactive', userId: 7 })
    expect(world.user!.password).toBe('OLD')
  })

  it('Super com VÍNCULO adormecido (tb_institution_has_user.active = N — o login dá 403): recusa `inactive` sem escrita (A-RS10, gates)', async () => {
    const world: World = { user: { id: 7, active: 'S', password: 'OLD' }, superLink: true, linkActive: 'N' }
    const { c, sql } = conn(world)
    await expect(resetSuperPasswordTx(c, 7, HASH)).resolves.toEqual({ status: 'inactive', userId: 7 })
    expect(world.user!.password).toBe('OLD')
    expect(sql.some(q => /^\s*UPDATE/.test(q))).toBe(false)
  })

  it('hash fora da forma da casa (senha em claro, minúsculas, outro tamanho) é recusado ANTES de tocar o banco', async () => {
    const { c, sql } = conn({ user: { id: 7, active: 'S', password: 'OLD' }, superLink: true })
    for (const bad of ['minha-senha', HASH.toLowerCase(), HASH.slice(0, 31), '']) {
      await expect(resetSuperPasswordTx(c, 7, bad)).rejects.toThrow(/hash da senha fora da forma da casa/)
    }
    expect(sql).toEqual([])
  })

  it('senha inicial: 16 caracteres do alfabeto sem ambíguos, aleatória, e o hash é o MESMO do login (md5Password)', () => {
    const a = generateInitialPassword(), b = generateInitialPassword()
    expect(a).toHaveLength(INITIAL_PASSWORD_LENGTH)
    expect(a).toMatch(new RegExp(`^[${INITIAL_PASSWORD_ALPHABET}]{16}$`))
    expect(a).not.toMatch(/[0OIl1]/)
    expect(a).not.toBe(b)
    expect(hashInitialPassword(a)).toBe(md5Password(a))
    expect(new Set(Array.from({ length: 50 }, () => generateInitialPassword())).size).toBe(50)
  })

  it('máscara do e-mail para o operador', () => {
    expect(maskEmail('valdo@setes.com.br')).toBe('v***@setes.com.br')
    expect(maskEmail(null)).toBe('(sem e-mail de login)')
    expect(maskEmail('semarroba')).toBe('***')
  })
})

// ---- D-RS7 (Valdo 2026-10-31): o alvo NOMEADO vale também entre 2+ Supers ATIVOS; sem nome, recusa; nenhuma recusa aponta tela -----
describe('D-RS7 — escolha do alvo (pickSuperTarget)', () => {
  const A: SuperAccount = { id: 7, active: 'S', loginEmail: 'ana@setes.com.br' }
  const B: SuperAccount = { id: 9, active: 'S', loginEmail: 'bia@setes.com.br' }
  const I: SuperAccount = { id: 11, active: 'N', loginEmail: 'ivo@setes.com.br' }
  const refusalOf = (c: ReturnType<typeof pickSuperTarget>) => ('refusal' in c ? c.refusal : undefined)

  it('S1: 2+ Supers ATIVOS sem nome → recusa, pede o nome e NÃO cita tela nenhuma', () => {
    const r = refusalOf(pickSuperTarget([A, B, I], {}))
    expect(r).toMatch(/há 2 Supers ATIVOS \(ids 7, 9\)/)
    expect(r).toMatch(/--user-id .* --email/)
    expect(r).not.toMatch(/tela/i)
  })

  it('S2: 2+ ativos com --user-id de um deles → o alvo é aquele, e só ele', () => {
    expect(pickSuperTarget([A, B], { userId: 9 })).toEqual({ target: B })
    expect(pickSuperTarget([A, B], { userId: 7 })).toEqual({ target: A })
  })

  it('S3: 2+ ativos com --email (sem caixa) → o alvo; e-mail de quem não é Super (ou de 2 Supers) → recusa', () => {
    expect(pickSuperTarget([A, B], { email: 'BIA@setes.com.br' })).toEqual({ target: B })
    expect(refusalOf(pickSuperTarget([A, B], { email: 'outro@setes.com.br' }))).toMatch(/nenhum Super \(ou mais de um\)/)
    const twin: SuperAccount = { id: 12, active: 'S', loginEmail: 'ana@setes.com.br' }
    expect(refusalOf(pickSuperTarget([A, twin], { email: 'ana@setes.com.br' }))).toMatch(/nenhum Super \(ou mais de um\)/)
  })

  it('S3b: --user-id de quem não é Super → recusa', () => {
    expect(refusalOf(pickSuperTarget([A, B], { userId: 999 }))).toMatch(/não é Super/)
  })

  it('S4: o inativo nomeado vira alvo do ENSAIO (o ato o recusa — D-RS16); sem nome e sem ativo, recusa sem reativar', () => {
    expect(pickSuperTarget([A, I], { userId: 11 })).toEqual({ target: I })
    expect(refusalOf(pickSuperTarget([I], {}))).toMatch(/nenhum Super ATIVO \(1 inativo\(s\)\).*não reativa/)
    expect(refusalOf(pickSuperTarget([], {}))).toMatch(/nenhum Super vivo/)
  })

  it('um só ativo continua implícito (com inativos na lista)', () => {
    expect(pickSuperTarget([A, I], {})).toEqual({ target: A })
  })

  it('--email vazio/só espaços nunca casa (nem o Super SEM e-mail de login); espaços em volta do e-mail não importam', () => {
    const semEmail: SuperAccount = { id: 3, active: 'S', loginEmail: null }
    expect(refusalOf(pickSuperTarget([semEmail, A], { email: '' }))).toMatch(/--email exige/)
    expect(refusalOf(pickSuperTarget([semEmail, A], { email: '   ' }))).toMatch(/--email exige/)
    expect(pickSuperTarget([semEmail, A, B], { email: '  Ana@Setes.com.br ' })).toEqual({ target: A })
  })

  it('a saída do Super inativo é a REAL: com outro ativo, a tela; sem outro ativo, só SQL manual (D-RS16) — nunca "nomeie o alvo"', () => {
    expect(inactiveTargetExit([A, I], I)).toMatch(/tela de Usuários \(outro Super ativo\)/)
    expect(inactiveTargetExit([I], I)).toMatch(/SQL manual do operador/)
    expect(inactiveTargetExit([I], I)).not.toMatch(/tela de Usuários \(outro/)
    const r = refusalOf(pickSuperTarget([I], {}))
    expect(r).toMatch(/SQL manual do operador/)
    expect(r).not.toMatch(/nomeie o alvo/)
  })
})

// ---- D-RS13 (Valdo 2026-10-31): depois de gravar, aviso NEUTRO ao e-mail de login do Super; falha do envio = log, a troca fica -------
describe('D-RS13 — aviso ao Super pela @shared/mailer', () => {
  const send = mailer.sendMail as jest.Mock
  const configured = mailer.isMailerConfigured as jest.Mock
  const production = mailer.isProduction as jest.Mock
  const AT = new Date('2026-11-01T18:42:30Z')
  const SUPER: SuperAccount = { id: 7, active: 'S', loginEmail: 'ana@setes.com.br' }
  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined)
    configured.mockReset().mockReturnValue(true)
    production.mockReset().mockReturnValue(false)
    ;(logger.error as jest.Mock).mockClear(); (logger.warn as jest.Mock).mockClear(); (logger.info as jest.Mock).mockClear()
  })

  it('o instante vai na parede da zona, em pt-BR e com o nome da zona; zona inválida cai na padrão', () => {
    expect(wallTimeInZone(AT, 'America/Sao_Paulo')).toBe('01/11/2026 15:42 (fuso America/Sao_Paulo)')
    expect(wallTimeInZone(AT, 'America/Manaus')).toBe('01/11/2026 14:42 (fuso America/Manaus)')
    expect(wallTimeInZone(AT, 'Lua/Crateras')).toBe('01/11/2026 15:42 (fuso America/Sao_Paulo)')
  })

  it('S5: UM e-mail ao e-mail de login GRAVADO, assunto próprio, texto neutro com o instante — sem link e sem senha', async () => {
    await expect(sendSuperResetNotice(SUPER, AT, 'America/Sao_Paulo')).resolves.toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
    const msg = send.mock.calls[0][0]
    expect(msg.to).toBe('ana@setes.com.br')
    expect(msg.subject).toBe(SUPER_RESET_NOTICE_SUBJECT)
    expect(msg.text).toBe(superResetNoticeText(AT, 'America/Sao_Paulo'))
    expect(msg.text).toMatch(/redefinida pelo operador do servidor em 01\/11\/2026 15:42 \(fuso America\/Sao_Paulo\)/)
    expect(msg.text).toMatch(/Se você não reconhece esta troca, avise/)
    for (const body of [msg.text, msg.html]) {
      expect(body).not.toMatch(/https?:\/\/|href=|www\./i)                // A-RS7: sem link de ação
      expect(body).not.toMatch(new RegExp(`[${INITIAL_PASSWORD_ALPHABET}]{16}`))   // nada com a forma da senha inicial
    }
    expect(sendSuperResetNotice.length).toBe(3)                           // a peça nem recebe a senha (conta, instante, zona)
  })

  it('S7: falha do envio → log de erro e "failed"; a peça NUNCA lança (a troca já gravada fica)', async () => {
    send.mockRejectedValue(Object.assign(new Error('ECONNREFUSED smtp'), { code: 'ESOCKET' }))
    await expect(sendSuperResetNotice(SUPER, AT, 'America/Sao_Paulo')).resolves.toBe('failed')
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/D-RS13: falha no envio/),
      expect.objectContaining({ userId: 7, to: 'a***@setes.com.br', code: 'ESOCKET' }))
  })

  it('D-EA24: envio preso além do teto → "unconfirmed" no teto (a senha pode aparecer); a confirmação TARDIA vai ao log', async () => {
    let finish!: () => void
    send.mockReturnValue(new Promise<void>(r => { finish = r }))
    const started = Date.now()
    await expect(sendSuperResetNotice(SUPER, AT, 'America/Sao_Paulo', 80)).resolves.toBe('unconfirmed')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/D-EA24: aviso ao Super NÃO confirmado/), { userId: 7, to: 'a***@setes.com.br' })
    finish()
    await new Promise(r => setImmediate(r))
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/confirmado DEPOIS do teto/), { userId: 7, to: 'a***@setes.com.br' })
  })

  it('D-EA24: envio que FALHA depois do teto → erro tardio no log, mascarado, sem rejeição solta', async () => {
    let fail!: (e: Error) => void
    send.mockReturnValue(new Promise<void>((_, rej) => { fail = rej }))
    await expect(sendSuperResetNotice(SUPER, AT, 'America/Sao_Paulo', 50)).resolves.toBe('unconfirmed')
    fail(Object.assign(new Error('550 <ana@setes.com.br> rejected'), { code: 'EENVELOPE' }))
    await new Promise(r => setImmediate(r))
    const [, meta] = (logger.error as jest.Mock).mock.calls.find(([m]) => /FALHOU depois do teto/.test(m))!
    expect(meta).toEqual(expect.objectContaining({ userId: 7, to: 'a***@setes.com.br', code: 'EENVELOPE' }))
    expect(JSON.stringify(meta)).not.toMatch(/ana@setes/)
  })

  it('D-EA24: envio que responde ANTES do teto → "sent" e o relógio é desligado (nada fica pendurado)', async () => {
    const clear = jest.spyOn(global, 'clearTimeout')
    await expect(sendSuperResetNotice(SUPER, AT, 'America/Sao_Paulo', 60_000)).resolves.toBe('sent')
    expect(clear).toHaveBeenCalled()
    clear.mockRestore()
  })

  it('D-EA24: o teto padrão é 60 s', () => {
    expect(SUPER_NOTICE_CAP_MS).toBe(60_000)
  })

  it('D-EA21: o erro do SMTP que traz o endereço vai ao log com o endereço MASCARADO', async () => {
    send.mockRejectedValue(Object.assign(new Error('Can\'t send mail - all recipients were rejected: 550 <ana@setes.com.br>: Recipient address rejected'),
      { code: 'EENVELOPE', responseCode: 550, rejected: ['ana@setes.com.br'], response: '550 <ana@setes.com.br>' }))
    await expect(sendSuperResetNotice(SUPER, AT, 'America/Sao_Paulo')).resolves.toBe('failed')
    const [, meta] = (logger.error as jest.Mock).mock.calls.find(([m]) => /D-RS13: falha no envio/.test(m))!
    expect(meta).toEqual(expect.objectContaining({ code: 'EENVELOPE', responseCode: 550 }))
    expect(meta.message).toMatch(/a\*\*\*@setes\.com\.br/)
    expect(JSON.stringify(meta)).not.toMatch(/ana@setes/)
  })

  it('S8: dev sem SMTP → o texto vai ao log ("logged"), com o e-mail MASCARADO e sem a senha', async () => {
    configured.mockReturnValue(false)
    await expect(sendSuperResetNotice(SUPER, AT, 'America/Sao_Paulo')).resolves.toBe('logged')
    const [, meta] = (logger.info as jest.Mock).mock.calls.find(([m]) => /D-RS13: aviso ao Super \(modo dev/.test(m))!
    expect(meta.to).toBe('a***@setes.com.br')
    expect(JSON.stringify(meta)).not.toMatch(/ana@setes/)
  })

  it('produção sem SMTP (o script roda fora do boot) → "failed" com erro no log, nunca "foi ao log"', async () => {
    configured.mockReturnValue(false); production.mockReturnValue(true)
    await expect(sendSuperResetNotice(SUPER, AT, 'America/Sao_Paulo')).resolves.toBe('failed')
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/SMTP ausente em PRODUÇÃO/), expect.anything())
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('e-mail de login GRAVADO que não é UM endereço válido (lista "a@x, b@y", lixo) → "failed", nenhum envio (ADV-RS13-02)', async () => {
    for (const bad of ['ana@setes.com.br, intruso@evil.test', 'ana@setes.com.br;b@x.test', 'Ana <ana@setes.com.br>', 'semarroba']) {
      send.mockClear()
      await expect(sendSuperResetNotice({ ...SUPER, loginEmail: bad }, AT, 'America/Sao_Paulo')).resolves.toBe('failed')
      expect(send).not.toHaveBeenCalled()
    }
  })

  it('Super sem e-mail de login → "no-email", nenhum envio, aviso no log', async () => {
    await expect(sendSuperResetNotice({ id: 8, active: 'S', loginEmail: null }, AT, 'America/Sao_Paulo')).resolves.toBe('no-email')
    expect(send).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/sem e-mail de login/), { userId: 8 })
  })

  it('a zona é a do estabelecimento da Setes (schema da institution 1 → config time_zone); falha da leitura = zona padrão', async () => {
    // a resolução pelo banco é dublada GLOBALMENTE (src/test-setup/time-zone.mock.ts); aqui se prova a DELEGAÇÃO à peça do fuso
    const zoneFor = timeZone.institutionZoneFor as jest.Mock
    zoneFor.mockResolvedValueOnce('America/Manaus')
    const q = { query: jest.fn().mockResolvedValueOnce([[{ schemaName: 'setes_rs13_probe' }]]) }
    await expect(setesInstitutionZone(q)).resolves.toBe('America/Manaus')
    expect(q.query.mock.calls[0][1]).toEqual([1])
    expect(zoneFor).toHaveBeenLastCalledWith('setes_rs13_probe', 1, q)    // a MESMA conexão (C1)
    const broken = { query: jest.fn().mockRejectedValue(new Error('banco fora')) }
    await expect(setesInstitutionZone(broken)).resolves.toBe('America/Sao_Paulo')
  })

  it('S6 (cerca): no script o aviso sai DEPOIS do COMMIT, FORA do withDeadlockRetry e ANTES da senha impressa (D-EA19)', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'reset-super-password.ts'), 'utf8').replace(/\r\n/g, '\n')
    const retryStart = src.indexOf('withDeadlockRetry(')
    const retryEnd = src.indexOf('\n  })\n', retryStart)
    const call = src.indexOf('sendSuperResetNotice(')
    const gate = src.indexOf("if (verdict.status !== 'reset')")
    const printed = src.indexOf('console.log(`\\n     ${password}\\n`)')
    // gate socrático (LOW-4): âncora que sumir (indexOf = -1) falha ALTO — a cerca nunca passa calada
    for (const anchor of [retryStart, call, gate, printed]) expect(anchor).toBeGreaterThan(0)
    expect(retryEnd).toBeGreaterThan(retryStart)
    expect(call).toBeGreaterThan(retryEnd)                                 // fora (depois) do bloco da retentativa
    expect(call).toBeGreaterThan(gate)                                     // só com a troca gravada
    expect(call).toBeLessThan(printed)                                     // D-EA19: o aviso PRECEDE a senha na tela
    expect(src.slice(retryStart, retryEnd)).not.toMatch(/sendMail|sendSuperResetNotice/)
  })
})

// ---- Parte 2: schema DESCARTÁVEL no MariaDB do dev --------------------------------------------------------------------------
const hasEnv = fs.existsSync(path.join(REPO, '.env'))
;(hasEnv ? describe : describe.skip)('D-PV46 — ao vivo em schema descartável (MariaDB do dev; setes_central só lida)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const cfg = () => ({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, timezone: 'Z' as const })
  const PROBE = `setes_superpw_probe_${Date.now().toString(36)}`
  let admin: import('mysql2/promise').Connection
  let before = ''

  /** A conexão do código real, com `setes_central.` trocado pelo descartável no TEXTO do SQL (molde de prove-password-reset-lock.ts). */
  const probeConn = (c: import('mysql2/promise').Connection): any => new Proxy(c, {
    get(target, prop, receiver) {
      if (prop === 'query') return (sql: string, params?: unknown[]) => target.query(sql.replace(/setes_central\./g, `\`${PROBE}\`.`), params as any)
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const fingerprint = async () => {
    const [r] = await admin.query<any[]>(
      `SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT(id, ':', COALESCE(password, ''), ':', COALESCE(updated_at, '')) ORDER BY id)) AS h
         FROM setes_central.tb_user`)
    return `${r[0].n}:${r[0].h}`
  }
  const passwordOf = async (id: number) => (await admin.query<any[]>(`SELECT password, activation_key AS ak FROM \`${PROBE}\`.tb_user WHERE id = ?`, [id]))[0][0]

  beforeAll(async () => {
    admin = await mysql.createConnection(cfg())
    before = await fingerprint()
    await admin.query(`CREATE SCHEMA \`${PROBE}\` DEFAULT CHARACTER SET utf8mb4`)
    for (const t of ['tb_user', 'tb_institution_has_user', 'tb_mailing', 'tb_entity_has_mailing']) {
      await admin.query(`CREATE TABLE \`${PROBE}\`.\`${t}\` LIKE setes_central.\`${t}\``)   // sem FK, sem dado
    }
    // D-EA7 (script sql/70): a coluna do instante da senha — a cópia nasce no formato DEPOIS da janela, mesmo antes de o 70 ir ao banco
    await admin.query(`ALTER TABLE \`${PROBE}\`.tb_user ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    const now = new Date()
    // 900001 Super ativo · 900002 admin · 900003 Super com USUÁRIO inativo · 900004 'super' em OUTRA institution (ignorado) ·
    // 900005 vínculo super EXCLUÍDO · 900006 Super com VÍNCULO adormecido (ihu.active = N — A-RS10) · 900007 Super ativo SEM e-mail de login
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_user (id, password, active, activation_key, created_at, updated_at, deleted) VALUES ?`, [[
      [900001, 'HASH1', 'S', '123456', now, now, 'N'], [900002, 'HASH2', 'S', null, now, now, 'N'], [900003, 'HASH3', 'N', null, now, now, 'N'],
      [900004, 'HASH4', 'S', null, now, now, 'N'], [900005, 'HASH5', 'S', null, now, now, 'N'], [900006, 'HASH6', 'S', null, now, now, 'N'],
      [900007, 'HASH7', 'S', null, now, now, 'N'],
    ]])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted) VALUES ?`, [[
      [1, 900001, 'super', 'S', now, now, 'N'], [1, 900002, 'admin', 'S', now, now, 'N'], [1, 900003, 'super', 'S', now, now, 'N'],
      [2, 900004, 'super', 'S', now, now, 'N'], [1, 900005, 'super', 'S', now, now, 'S'], [1, 900006, 'super', 'N', now, now, 'N'],
      [1, 900007, 'super', 'S', now, now, 'N'],
    ]])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_mailing (id, email, created_at, updated_at, deleted) VALUES (900001, 'super@probe.test', ?, ?, 'N')`, [now, now])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_entity_has_mailing (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted)
                       VALUES (900001, 900001, 2, ?, ?, 'N')`, [now, now])
  }, 30000)

  afterAll(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS \`${PROBE}\``)
      expect(await fingerprint()).toBe(before)                                // setes_central intacta
    } finally {
      await admin.end()
    }
  }, 30000)

  it('lista só os Supers da institution da Setes (vivo e inativo), com o e-mail de login gravado', async () => {
    const supers = await listSuperAccounts(probeConn(admin))
    expect(supers).toEqual([
      { id: 900001, active: 'S', loginEmail: 'super@probe.test' },
      { id: 900003, active: 'N', loginEmail: null },
      { id: 900006, active: 'N', loginEmail: null },                      // vínculo adormecido = inativo (predicado do login — A-RS10)
      { id: 900007, active: 'S', loginEmail: null },                      // ativo SEM e-mail de login (D-EA20)
    ])
  })

  it('recusa admin, "super" de outra institution, vínculo excluído e Super inativo — sem escrita; redefine só o Super ativo', async () => {
    const tx = async (id: number, hash: string) => {
      const c = await mysql.createConnection(cfg())
      try {
        await c.beginTransaction()
        const v = await resetSuperPasswordTx(probeConn(c), id, hash)
        if (v.status === 'reset') await c.commit(); else await c.rollback()
        return v
      } finally { await c.end() }
    }
    const hash = hashInitialPassword(generateInitialPassword())
    expect(await tx(900002, hash)).toEqual({ status: 'not-super', userId: 900002 })
    expect(await tx(900004, hash)).toEqual({ status: 'not-super', userId: 900004 })
    expect(await tx(900005, hash)).toEqual({ status: 'not-super', userId: 900005 })
    expect(await tx(900003, hash)).toEqual({ status: 'inactive', userId: 900003 })
    expect(await tx(900006, hash)).toEqual({ status: 'inactive', userId: 900006 })   // vínculo adormecido (A-RS10)
    expect(await tx(900007, hash)).toEqual({ status: 'no-login-email', userId: 900007 })   // D-EA20: sem e-mail de login
    expect(await tx(999999, hash)).toEqual({ status: 'not-super', userId: 999999 })
    for (const [id, h] of [[900002, 'HASH2'], [900003, 'HASH3'], [900004, 'HASH4'], [900005, 'HASH5'], [900006, 'HASH6'], [900007, 'HASH7']] as const) {
      expect((await passwordOf(id)).password).toBe(h)
    }
    expect(await tx(900001, hash)).toEqual({ status: 'reset', userId: 900001, loginEmail: 'super@probe.test' })
    const after = await passwordOf(900001)
    expect(after.password).toBe(hash)                                        // o MESMO hash que o login compara (md5 upper)
    expect(after.ak).toBeNull()                                              // código antigo em texto puro limpo (peça do fluxo normal)
  }, 30000)

  it('o script sem --vai é ENSAIO: lista o(s) Super(s) do banco real (só leitura) e não grava nada', () => {
    // gate socrático (LOW-4): a RECUSA (2+ ativos sem nome — normal com a D-RS7) sai em stderr com código 2; o spawnSync separa a
    // recusa honesta (2) da falha (1) — o execFileSync lançava nos dois e o teste quebrava pelo motivo errado
    const run = spawnSync('npx', ['tsx', '--require', 'tsconfig-paths/register', 'scripts/reset-super-password.ts'],
      { cwd: REPO, encoding: 'utf8', shell: true, timeout: 120000 })
    const all = `${run.stdout}\n${run.stderr}`
    expect([0, 2]).toContain(run.status)
    expect(run.stdout).toMatch(/Supers vivos na institution da Setes: \d+/)
    if (run.status === 0) expect(run.stdout).toMatch(/ENSAIO — nada gravado/)
    else expect(run.stderr).toMatch(/há \d+ Supers ATIVOS|nenhum Super/)
    expect(all).not.toMatch(/Senha INICIAL/)
    expect(all).not.toMatch(/Aviso enviado|Aviso ao Super/)                 // D-RS13: sem --vai, nenhum e-mail
  }, 150000)
})
