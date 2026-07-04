import request from 'supertest'
import jwt     from 'jsonwebtoken'
import app     from '../app'

const SECRET = process.env.JWT_SECRET ?? 'sua_chave_secreta_aqui'

function makeToken(payload: object, secret = SECRET) {
  return jwt.sign(payload, secret, { expiresIn: '1h' })
}

describe('auth.middleware', () => {
  it('retorna 200 em /health sem token', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })

  it('retorna 401 sem Authorization header', async () => {
    const res = await request(app).get('/api/core/info')
    expect(res.status).toBe(401)
  })

  it('retorna 401 com token malformado', async () => {
    const res = await request(app)
      .get('/api/core/info')
      .set('Authorization', 'Bearer token.invalido.aqui')
    expect(res.status).toBe(401)
  })

  it('retorna 401 com token assinado com secret errado', async () => {
    const token = makeToken(
      { tenantId: 'tenant-001', userId: 'u1', role: 'client_user', schemaName: 'setes_alpha' },
      'secret_errado'
    )
    const res = await request(app)
      .get('/api/core/info')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('passa com token válido (não testa banco, apenas o middleware)', async () => {
    const token = makeToken({
      tenantId: 'tenant-001',
      userId:   'user-001',
      role:     'client_user',
      schemaName: 'setes_alpha',
    })
    // Pode retornar 500 se o banco não estiver acessível no CI,
    // mas não deve retornar 401 — o middleware de auth passou
    const res = await request(app)
      .get('/api/core/info')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).not.toBe(401)
  })
})
