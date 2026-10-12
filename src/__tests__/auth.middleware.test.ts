import request from 'supertest'
import jwt     from 'jsonwebtoken'
import app     from '../app'
import { testToken } from '../test-setup/test-token'
import { SELECTION_SCOPE } from '../shared/auth/product-token'

// D-F13 (F2a, etapa A2 — prompt_apis_fiscais_isoladas.md §22.9): o token do produto é RS256 com `kid`.
const FINAL = { institutionId: 2, userId: 2, role: 'user', schemaName: 'setes_alpha' }

async function call(token?: string) {
  const r = request(app).get('/api/core/info')
  return token === undefined ? r : r.set('Authorization', `Bearer ${token}`)
}

describe('auth.middleware', () => {
  it('retorna 200 em /health sem token', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })

  it('retorna 401 sem Authorization header', async () => {
    expect((await call()).status).toBe(401)
  })

  it('retorna 401 com token malformado', async () => {
    expect((await call('token.invalido.aqui')).status).toBe(401)
  })

  it('passa com token RS256 válido (não testa banco, apenas o middleware)', async () => {
    // Pode retornar 500 se o banco não estiver acessível no CI, mas não 401 — o middleware passou
    expect((await call(testToken(FINAL))).status).not.toBe(401)
  })

  describe('D-F13 — recusas', () => {
    it('HS256 (o modelo aposentado) → 401, com qualquer segredo — inclusive o do ambiente', async () => {
      process.env.JWT_SECRET = 'segredo-hs256-aposentado'
      for (const secret of ['sua_chave_secreta_aqui', process.env.JWT_SECRET]) {
        expect((await call(jwt.sign(FINAL, secret, { keyid: process.env.JWT_KID }))).status).toBe(401)
      }
    })
    it('assinado por OUTRA chave RSA com o kid de teste → 401 (assinatura não confere)', async () => {
      expect((await call(testToken(FINAL, { keyPath: process.env.TEST_JWT_OTHER_KEY_PATH }))).status).toBe(401)
    })
    it('sem kid ou com kid desconhecido → 401', async () => {
      expect((await call(testToken(FINAL, { kid: null }))).status).toBe(401)
      expect((await call(testToken(FINAL, { kid: 'outro' }))).status).toBe(401)
    })
    it('expirado → 401 "Token expirado"', async () => {
      const res = await call(testToken(FINAL, { expiresIn: -10 }))
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Token expirado')
    })
    it('alg none → 401', async () => {
      const none = jwt.sign(FINAL, '', { algorithm: 'none' as any, keyid: process.env.JWT_KID })
      expect((await call(none)).status).toBe(401)
    })
    it('o token de SELEÇÃO não autentica rota (marca própria — scope)', async () => {
      expect((await call(testToken({ userId: 2, scope: SELECTION_SCOPE }, { expiresIn: '5m' }))).status).toBe(401)
      // nem com a identidade completa junto: `scope` presente = não é token final
      expect((await call(testToken({ ...FINAL, scope: SELECTION_SCOPE }))).status).toBe(401)
    })
    it('forma incompleta ou schema fora do padrão → 401', async () => {
      for (const p of [
        { ...FINAL, institutionId: 0 }, { ...FINAL, institutionId: '2' }, { ...FINAL, role: '' },
        { ...FINAL, schemaName: 'outro_schema' }, { ...FINAL, schemaName: 'setes_x`; DROP' }, { userId: 2, role: 'user' },
      ]) {
        expect((await call(testToken(p))).status).toBe(401)
      }
    })
  })
})
