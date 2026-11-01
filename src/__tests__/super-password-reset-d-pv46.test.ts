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
import { execFileSync } from 'child_process'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import {
  listSuperAccounts, resetSuperPasswordTx, generateInitialPassword, hashInitialPassword, maskEmail,
  INITIAL_PASSWORD_ALPHABET, INITIAL_PASSWORD_LENGTH,
} from '../modules/auth/super-password-reset'
import { md5Password } from '../shared/auth/password'

const REPO = path.join(__dirname, '..', '..')

// ---- Parte 1: a peça, com dublê de conexão -----------------------------------------------------------------------------------
describe('D-PV46 — a peça do reset do Super (dublê)', () => {
  interface World { user?: { id: number; active: string; password: string | null }; superLink: boolean; linkActive?: string }
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
    await expect(resetSuperPasswordTx(c, 7, HASH)).resolves.toEqual({ status: 'reset', userId: 7 })
    expect(world.user!.password).toBe(HASH)
    expect(sql[0]).toMatch(/FOR UPDATE/)                                   // 1º statement = a trava do usuário (regra 12)
    expect(sql[1]).toMatch(/kind = 'super'/)
    // D-EA7: o script define a senha pela MESMA peça — o instante T vai junto (as sessões anteriores do Super caem)
    expect(sql[2]).toMatch(/UPDATE setes_central\.tb_user SET password = \?, password_set_at = \?, activation_key = NULL, updated_at = NOW\(\)/)
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
    // 900005 vínculo super EXCLUÍDO · 900006 Super com VÍNCULO adormecido (ihu.active = N — A-RS10)
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_user (id, password, active, activation_key, created_at, updated_at, deleted) VALUES ?`, [[
      [900001, 'HASH1', 'S', '123456', now, now, 'N'], [900002, 'HASH2', 'S', null, now, now, 'N'], [900003, 'HASH3', 'N', null, now, now, 'N'],
      [900004, 'HASH4', 'S', null, now, now, 'N'], [900005, 'HASH5', 'S', null, now, now, 'N'], [900006, 'HASH6', 'S', null, now, now, 'N'],
    ]])
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted) VALUES ?`, [[
      [1, 900001, 'super', 'S', now, now, 'N'], [1, 900002, 'admin', 'S', now, now, 'N'], [1, 900003, 'super', 'S', now, now, 'N'],
      [2, 900004, 'super', 'S', now, now, 'N'], [1, 900005, 'super', 'S', now, now, 'S'], [1, 900006, 'super', 'N', now, now, 'N'],
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
    expect(await tx(999999, hash)).toEqual({ status: 'not-super', userId: 999999 })
    for (const [id, h] of [[900002, 'HASH2'], [900003, 'HASH3'], [900004, 'HASH4'], [900005, 'HASH5'], [900006, 'HASH6']] as const) {
      expect((await passwordOf(id)).password).toBe(h)
    }
    expect(await tx(900001, hash)).toEqual({ status: 'reset', userId: 900001 })
    const after = await passwordOf(900001)
    expect(after.password).toBe(hash)                                        // o MESMO hash que o login compara (md5 upper)
    expect(after.ak).toBeNull()                                              // código antigo em texto puro limpo (peça do fluxo normal)
  }, 30000)

  it('o script sem --vai é ENSAIO: lista o(s) Super(s) do banco real (só leitura) e não grava nada', () => {
    const out = execFileSync('npx', ['tsx', '--require', 'tsconfig-paths/register', 'scripts/reset-super-password.ts'],
      { cwd: REPO, encoding: 'utf8', shell: true, timeout: 120000 })
    expect(out).toMatch(/Supers vivos na institution da Setes: \d+/)
    expect(out).toMatch(/ENSAIO — nada gravado|há \d+ Supers ATIVOS|nenhum Super/)
    expect(out).not.toMatch(/Senha INICIAL/)
  }, 150000)
})
