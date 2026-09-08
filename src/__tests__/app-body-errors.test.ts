/// <reference types="jest" />
// Handler global (src/app.ts) — gate adversarial 2026-09-06 (negociação do
// pedido), achado TRANSVERSAL: body JSON malformado/primitivo caía no 500
// genérico sem code/ref. Erro do CLIENTE = contrato {error, code, fields[]}.
import request from 'supertest'
import app from '../app'

describe('express.json → handler global', () => {
  it('JSON malformado -> 400 INVALID_JSON com o envelope padrão (antes de qualquer auth)', async () => {
    const res = await request(app)
      .put('/api/orders/1/negotiation')
      .set('Content-Type', 'application/json')
      .send('{bad json')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Corpo da requisição não é um JSON válido', code: 'INVALID_JSON', fields: [] })
  })

  it('primitivo JSON ("x") -> 400 INVALID_JSON', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('"x"')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_JSON')
  })

  it('payload acima do limite (2mb) -> 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send(`{"email":"${'a'.repeat(2 * 1024 * 1024 + 10)}"}`)
    expect(res.status).toBe(413)
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE')
  })
})
