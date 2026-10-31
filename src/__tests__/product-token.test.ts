/// <reference types="jest" />
// D-F13 (F2a, etapa A2 — prompt_apis_fiscais_isoladas.md §22.9): o JWT do produto é RS256 com `kid`, assinado SÓ pelo
// setes-api (`@shared/auth/product-token`). Configuração que falha ALTO, rotação por `kid`, marca própria dos dois tokens.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'crypto'
import jwt from 'jsonwebtoken'
import {
  loadJwtKeyRing, resetJwtKeyRing, assertJwtKeys, signFinalToken, signSelectionToken, verifyFinalToken, verifySelectionToken,
  SELECTION_SCOPE,
} from '../shared/auth/product-token'
import { testToken } from '../test-setup/test-token'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'product-token-'))
function pem(name: string, kind: 'rsa2048' | 'rsa1024' | 'ec', which: 'private' | 'public' = 'private'): string {
  const pair = kind === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : generateKeyPairSync('rsa', { modulusLength: kind === 'rsa1024' ? 1024 : 2048 })
  const file = path.join(DIR, `${name}.${which}.pem`)
  fs.writeFileSync(file, which === 'private' ? pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) : pair.publicKey.export({ type: 'spki', format: 'pem' }))
  return file
}
const ENV0 = { ...process.env }
const FINAL = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }

afterEach(() => { process.env = { ...ENV0 }; resetJwtKeyRing() })
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }))

describe('configuração — falha ALTO, nunca cai para HS256', () => {
  it('sem JWT_PRIVATE_KEY_PATH → erro que manda configurar (e diz que JWT_SECRET aposentou); o boot não sobe', () => {
    expect(() => loadJwtKeyRing({ JWT_SECRET: 'x' })).toThrow(/JWT_PRIVATE_KEY_PATH[\s\S]*JWT_SECRET \(HS256\) foi aposentada/)
    delete process.env.JWT_PRIVATE_KEY_PATH
    resetJwtKeyRing()
    expect(() => assertJwtKeys()).toThrow(/JWT_PRIVATE_KEY_PATH/)
  })
  it('arquivo ausente, PEM público no lugar do privado, chave EC ou RSA < 2048 → erro sem expor a chave', () => {
    expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: path.join(DIR, 'nao-existe.pem') })).toThrow(/ilegível/)
    expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: pem('pub', 'rsa2048', 'public') })).toThrow(/ilegível|privada/)
    expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: pem('ec', 'ec') })).toThrow(/não é RSA/)
    expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: pem('small', 'rsa1024') })).toThrow(/1024 bits/)
    try { loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: pem('pub2', 'rsa2048', 'public') }) } catch (e: any) { expect(e.message).not.toMatch(/BEGIN/) }
  })
  it('JWT_KID padrão "default" (o nome que a nfse-api dá a JWT_PUBLIC_KEY_PATH); kid fora do formato → erro', () => {
    const k = pem('k', 'rsa2048')
    expect(loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: k }).kid).toBe('default')
    expect(loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: k, JWT_KID: ' setes-2026-10 ' }).kid).toBe('setes-2026-10')
    expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: k, JWT_KID: 'a b' })).toThrow(/JWT_KID inválido/)
  })
  it('JWT_PUBLIC_KEYS: mal formada, kid repetido (inclusive o de assinatura) ou chave ilegível → erro', () => {
    const k = pem('k2', 'rsa2048'); const old = pem('old', 'rsa2048', 'public')
    expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: k, JWT_PUBLIC_KEYS: old })).toThrow(/mal formada/)
    expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: k, JWT_KID: 'a', JWT_PUBLIC_KEYS: `a=${old}` })).toThrow(/repete o kid 'a'/)
    expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: k, JWT_PUBLIC_KEYS: `x=${old},x=${old}` })).toThrow(/repete o kid 'x'/)
    expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: k, JWT_PUBLIC_KEYS: `x=${path.join(DIR, 'nada.pem')}` })).toThrow(/'x' ilegível/)
  })
})

describe('assinatura e verificação', () => {
  it('token final: RS256 com o kid de assinatura, só os 4 campos da identidade; verificado devolve só eles', () => {
    const t = signFinalToken({ ...FINAL, extra: 'x' } as any)
    const { header, payload } = jwt.decode(t, { complete: true }) as any
    expect(header).toMatchObject({ alg: 'RS256', kid: process.env.JWT_KID })
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'institutionId', 'role', 'schemaName', 'userId'])
    expect(payload.exp - payload.iat).toBe(24 * 3600)
    expect(verifyFinalToken(t)).toEqual(FINAL)
  })
  it('marca própria: o de SELEÇÃO não vale como final e o final não vale como seleção', () => {
    const sel = signSelectionToken(7)
    expect(verifySelectionToken(sel)).toEqual({ userId: 7, iat: expect.any(Number) })   // D-EA7: o iat confere a sessão na seleção
    expect(() => verifyFinalToken(sel)).toThrow(/Token inválido/)
    expect(() => verifySelectionToken(signFinalToken(FINAL))).toThrow(/seleção inválido/)
    const { payload } = jwt.decode(sel, { complete: true }) as any
    expect(payload.scope).toBe(SELECTION_SCOPE)
    expect(payload.exp - payload.iat).toBe(5 * 60)
  })
  it('HS256 com o PEM público como segredo (confusão de algoritmo) → recusado', () => {
    const pub = createPublicKey(createPrivateKey(fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH!, 'utf8'))).export({ type: 'spki', format: 'pem' }).toString()
    const forged = jwt.sign(FINAL, pub, { algorithm: 'HS256', keyid: process.env.JWT_KID } as any)
    expect(() => verifyFinalToken(forged)).toThrow(/Token inválido/)
  })
  it('ROTAÇÃO: kid novo assina; o token do kid ANTERIOR (em JWT_PUBLIC_KEYS) vale até expirar; kid retirado → recusado', () => {
    const oldPrivate = process.env.JWT_PRIVATE_KEY_PATH!
    const oldToken = testToken(FINAL, { kid: 'test' })
    const oldPublic = path.join(DIR, 'old-test.public.pem')
    fs.writeFileSync(oldPublic, createPublicKey(createPrivateKey(fs.readFileSync(oldPrivate, 'utf8'))).export({ type: 'spki', format: 'pem' }))
    process.env.JWT_PRIVATE_KEY_PATH = pem('novo', 'rsa2048'); process.env.JWT_KID = 'novo'
    process.env.JWT_PUBLIC_KEYS = `test=${oldPublic}`
    resetJwtKeyRing()
    expect(assertJwtKeys()).toBe("RS256, kid 'novo' + 1 chave(s) anterior(es)")
    expect(verifyFinalToken(oldToken)).toEqual(FINAL)
    expect((jwt.decode(signFinalToken(FINAL), { complete: true }) as any).header.kid).toBe('novo')
    delete process.env.JWT_PUBLIC_KEYS
    resetJwtKeyRing()
    expect(() => verifyFinalToken(oldToken)).toThrow(/Token inválido/)
  })
  it('expirado → "Token expirado"; lixo/sem kid → "Token inválido" (401)', () => {
    expect(() => verifyFinalToken(testToken(FINAL, { expiresIn: -1 }))).toThrow(/Token expirado/)
    for (const t of ['', 'a.b.c', testToken(FINAL, { kid: null })]) {
      try { verifyFinalToken(t); throw new Error('passou') } catch (e: any) { expect(e).toMatchObject({ statusCode: 401, message: 'Token inválido' }) }
    }
  })
})
