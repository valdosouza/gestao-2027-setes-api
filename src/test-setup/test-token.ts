/**
 * Assinador de TESTE do JWT do produto (D-F13 — F2a, etapa A2): RS256 com a chave e o `kid` de teste que o setup
 * global (`./jwt-keys`) pôs no ambiente — o mesmo par que o `authMiddleware` verifica. Para um token FINAL válido,
 * `testToken({ institutionId, userId, role, schemaName })`; as opções forjam os casos que têm de ser recusados.
 */
import fs from 'fs'
import jwt, { SignOptions } from 'jsonwebtoken'

export interface TestTokenOptions {
  expiresIn?: string | number
  /** `kid` do cabeçalho; `null` = sem kid. Padrão: o kid de teste (JWT_KID). */
  kid?: string | null
  /** Caminho de OUTRA chave privada (padrão: a de teste do ambiente). */
  keyPath?: string
}

export function testToken(payload: object, opts: TestTokenOptions = {}): string {
  const key = fs.readFileSync(opts.keyPath ?? process.env.JWT_PRIVATE_KEY_PATH!, 'utf8')
  const kid = opts.kid === undefined ? process.env.JWT_KID : opts.kid
  const options: SignOptions = { algorithm: 'RS256', expiresIn: (opts.expiresIn ?? '1h') as any }
  if (kid) options.keyid = kid
  return jwt.sign(payload, key, options)
}

/** `Bearer <token final>` — atalho dos testes de rota. */
export function bearer(payload: { institutionId: number; userId: number; role: string; schemaName: string }): string {
  return `Bearer ${testToken(payload)}`
}
