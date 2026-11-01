/// <reference types="jest" />
// D-EA7 (Valdo 2026-10-31 — Infra-IA/prompts/prompt_endurecer_autenticacao.md; parecer do guardião): trocar a senha derruba as sessões
// emitidas ANTES. O fato "a senha que vale hoje foi definida em T" (`tb_user.password_set_at`, script sql/70) é gravado SÓ pela peça
// "definir a senha", JUNTO do hash; a sessão viva compara o `iat` do token com ele NA MESMA leitura (`vw_user_link`). Cercas:
//  - todo SQL de PRODUÇÃO que grava `tb_user.password` grava `password_set_at` no MESMO comando (o par);
//  - o middleware e a troca do token de SELEÇÃO conferem a sessão COM o `iat`;
//  - token sem `iat` = 401 (sem ele a revogação seria falha aberta).
// A semântica da fronteira (`iat = T` vale; `iat < T` revoga; NULL = sem revogação) é provada em banco descartável:
// `scripts/prove-user-access-views.ts`.
import fs from 'fs'
import path from 'path'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '../app'
import { passwordSetAt } from '../shared/auth/password'
import { verifyFinalTokenWithIat, verifySelectionToken, signSelectionToken } from '../shared/auth/product-token'
import * as access from '../shared/access'

const SRC = path.resolve(__dirname, '..')
function prodFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) return d.name === '__tests__' || d.name === 'test-setup' ? [] : prodFiles(p)
    return /\.ts$/.test(d.name) ? [p] : []
  })
}

/** Literais de SQL (texto entre crases ou aspas) que gravam a senha da credencial. */
function passwordWrites(): { file: string; sql: string }[] {
  const out: { file: string; sql: string }[] = []
  for (const f of prodFiles(SRC)) {
    const code = fs.readFileSync(f, 'utf8')
    for (const m of code.matchAll(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g)) {
      const t = m[0].replace(/\s+/g, ' ')
      const updates = /\bUPDATE\s+[`\w.]*tb_user\b[^;]*\bSET\b[^;]*\bpassword\s*=/i.test(t)
      const inserts = /\bINSERT\s+INTO\s+[`\w.]*tb_user\s*\([^)]*\bpassword\b/i.test(t)
      if (updates || inserts) out.push({ file: path.relative(SRC, f).replace(/\\/g, '/'), sql: t })
    }
  }
  return out
}

// Conhecimento negativo para a D-EA9 (scrypt, Onda 4 do `prompt_endurecer_autenticacao.md`): a regravação do hash no login (mesma senha,
// outro formato) NÃO toca o `password_set_at` — não derruba sessão. Ela nasce como a EXCEÇÃO NOMEADA desta cerca (função própria que grava
// só o hash), nunca afrouxando a regra para os outros escritores.
describe('D-EA7 — o par (hash, T): quem grava a senha grava o instante junto', () => {
  it('todo SQL de produção que grava tb_user.password grava password_set_at no MESMO comando', () => {
    const writes = passwordWrites()
    expect(writes.length).toBeGreaterThanOrEqual(3)                         // criação, 1ª senha (A-PV23), troca pelo código/script do Super
    expect(writes.filter(w => !/\bpassword_set_at\b/.test(w.sql)).map(w => `${w.file}: ${w.sql.slice(0, 120)}`)).toEqual([])
    expect(writes.map(w => w.file).sort()).toEqual(
      ['modules/auth/auth.repository.ts', 'modules/users/users.repository.ts', 'shared/user/index.ts'])
  })

  it('o instante é o do relógio de quem assina o token, em UTC, ao segundo (nunca NOW() do banco)', () => {
    expect(passwordSetAt(new Date('2026-10-31T23:59:59.987Z'))).toBe('2026-10-31 23:59:59')
    expect(passwordSetAt()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    for (const w of passwordWrites()) expect([w.file, /password_set_at\s*=\s*NOW\(\)/i.test(w.sql)]).toEqual([w.file, false])
  })
})

describe('D-EA7 — a sessão confere com o iat', () => {
  const key = () => fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH!, 'utf8')
  const sign = (payload: object, opts: jwt.SignOptions = {}) =>
    jwt.sign(payload, key(), { algorithm: 'RS256', keyid: process.env.JWT_KID, expiresIn: '1h', ...opts })
  const WHO = { institutionId: 1, userId: 3, role: 'admin', schemaName: 'setes_setes' }

  it('token final SEM iat → 401 (o verificador exige; o middleware nem lê a sessão)', async () => {
    expect(() => verifyFinalTokenWithIat(sign(WHO, { noTimestamp: true }))).toThrow()
    const live = access.liveSession as jest.Mock
    live.mockClear()
    const r = await request(app).get('/api/core/me').set('Authorization', `Bearer ${sign(WHO, { noTimestamp: true })}`)
    expect([r.status, r.body.code]).toEqual([401, 'UNAUTHORIZED'])
    expect(live).not.toHaveBeenCalled()
  })

  it('o middleware passa o iat do token à sessão viva', async () => {
    const live = access.liveSession as jest.Mock
    live.mockClear()
    const iat = Math.floor(Date.now() / 1000) - 30
    await request(app).get('/api/core/me').set('Authorization', `Bearer ${sign({ ...WHO, iat })}`)
    expect(live).toHaveBeenCalledWith(expect.objectContaining({ userId: 3, institutionId: 1 }), iat)
  })

  it('sessão revogada (senha trocada depois do token) → 401 SESSION_REVOKED', async () => {
    ;(access.liveSession as jest.Mock).mockResolvedValueOnce(null)
    const r = await request(app).get('/api/core/me').set('Authorization', `Bearer ${sign(WHO)}`)
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED'])
  })

  it('o token de SELEÇÃO devolve o iat (sem ele, recusado) — a troca pelo final confere a sessão com ele', () => {
    const sel = verifySelectionToken(signSelectionToken(3))
    expect(sel.userId).toBe(3)
    expect(Math.abs(sel.iat - Math.floor(Date.now() / 1000))).toBeLessThan(5)
    const svc = fs.readFileSync(path.join(SRC, 'modules', 'auth', 'auth.service.ts'), 'utf8')
    expect(svc).toMatch(/issueForInstitution\(selection\.userId, institutionId, selection\.iat\)/)
    expect(svc).toMatch(/liveSession\(who, selectionIat\)/)
    const src = fs.readFileSync(path.join(SRC, 'shared', 'auth', 'product-token.ts'), 'utf8')
    expect(src).toMatch(/verifySelectionToken[\s\S]*?!isPositiveInt\(p\.iat\)/)
  })
})
