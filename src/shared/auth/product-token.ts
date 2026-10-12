import fs from 'fs'
import { createPrivateKey, createPublicKey, KeyObject } from 'crypto'
import jwt, { JwtHeader } from 'jsonwebtoken'
import { InstitutionPayload } from '@shared/types/express'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'

/**
 * JWT do PRODUTO em RS256 com `kid` (D-F13 — Valdo 2026-10-03; ligado no setes-api na F2a, etapa A2,
 * Infra-IA/prompts/prompt_apis_fiscais_isoladas.md §22.9). O setes-api é o ÚNICO que assina (chave PRIVADA);
 * as APIs do produto (nfse-api, nfe-api) só têm a(s) PÚBLICA(S) — verificam, nunca forjam. O mesmo token
 * serve aos dois lados (D-F4: o app fala direto com as APIs do produto).
 *
 * Antes era HS256 com `JWT_SECRET` — segredo simétrico que qualquer verificador também usaria para ASSINAR (e
 * que vazou: estava fixo num script versionado de repositório público). HS256 é recusado por construção
 * (`algorithms: ['RS256']`); `JWT_SECRET` não é lida.
 *
 * Dois tokens com MARCA PRÓPRIA (§22.5 item 6) — um nunca vale pelo outro:
 *  - FINAL  `{ institutionId, userId, role, schemaName }` (TTL 24h) — identidade mínima (PADROES_BANCO §7);
 *    o verificador exige a forma e recusa `scope` (o token de seleção nunca autentica uma rota).
 *  - SELEÇÃO `{ userId, scope: 'select-institution' }` (TTL 5m) — só para escolher a institution no login com
 *    N vínculos; recusa `institutionId` (o final nunca serve de seleção). A nfse-api já o recusa pela forma.
 *
 * Configuração (falha ALTA no boot sem chave — `assertJwtKeys`):
 *  - `JWT_PRIVATE_KEY_PATH` — PEM da chave privada RSA (≥ 2048 bits) que assina;
 *  - `JWT_KID` — o `kid` dela (padrão 'default' — o mesmo nome que a nfse-api dá a `JWT_PUBLIC_KEY_PATH`);
 *  - `JWT_PUBLIC_KEYS` (opcional) — "kid=caminho.pem,…": chaves ANTERIORES ainda aceitas na verificação durante
 *    uma ROTAÇÃO (o token novo sai com o `kid` novo; o velho vale até expirar). O `kid` de assinatura não se repete aqui.
 * Token sem `kid` ou com `kid` desconhecido, ou sem `exp`, = 401.
 */

export const JWT_ALGORITHM = 'RS256' as const
export const FINAL_TOKEN_TTL = '24h'                 // decisão 19 da Fase 1: TTL 24h, sem refresh
export const SELECTION_TOKEN_TTL = '5m'
export const SELECTION_SCOPE = 'select-institution'

const KID_RE = /^[A-Za-z0-9._-]{1,64}$/
const SCHEMA_RE = /^setes_[a-z0-9_]+$/               // o mesmo de @shared/db/schema (validado aqui sem lançar 400)

export interface JwtKeyRing {
  kid: string
  privateKey: KeyObject
  publicKeys: ReadonlyMap<string, KeyObject>
}

function rsaKey(key: KeyObject, what: string): KeyObject {
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`${what}: a chave não é RSA (D-F13 — RS256)`)
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < 2048) throw new Error(`${what}: chave RSA de ${bits} bits — o mínimo é 2048`)
  return key
}

/** Lê e confere as chaves do ambiente. Lança erro com a instrução (nunca com o conteúdo da chave). */
export function loadJwtKeyRing(env: NodeJS.ProcessEnv = process.env): JwtKeyRing {
  const privatePath = String(env.JWT_PRIVATE_KEY_PATH ?? '').trim()
  if (!privatePath) {
    throw new Error('Configure JWT_PRIVATE_KEY_PATH (chave PRIVADA RS256 do setes-api — D-F13); JWT_SECRET (HS256) foi aposentada na F2a')
  }
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey(fs.readFileSync(privatePath, 'utf8'))
  } catch (err: any) {
    throw new Error(`JWT_PRIVATE_KEY_PATH ilegível ou não é uma chave privada PEM (${err?.code ?? err?.message ?? 'erro'})`)
  }
  rsaKey(privateKey, 'JWT_PRIVATE_KEY_PATH')
  const kid = String(env.JWT_KID ?? 'default').trim()
  if (!KID_RE.test(kid)) throw new Error('JWT_KID inválido — use letras, dígitos, ponto, hífen ou sublinhado (até 64)')
  const publicKeys = new Map<string, KeyObject>([[kid, createPublicKey(privateKey)]])
  const extra = String(env.JWT_PUBLIC_KEYS ?? '').trim()
  for (const part of extra ? extra.split(',').map(s => s.trim()).filter(Boolean) : []) {
    const i = part.indexOf('=')
    const k = i > 0 ? part.slice(0, i).trim() : ''
    if (!KID_RE.test(k)) throw new Error('JWT_PUBLIC_KEYS mal formada — use "kid=caminho.pem,…"')
    if (publicKeys.has(k)) throw new Error(`JWT_PUBLIC_KEYS repete o kid '${k}' (o kid de assinatura e cada chave anterior aparecem uma vez só)`)
    let pub: KeyObject
    try {
      pub = createPublicKey(fs.readFileSync(part.slice(i + 1).trim(), 'utf8'))
    } catch (err: any) {
      throw new Error(`JWT_PUBLIC_KEYS: chave '${k}' ilegível ou não é PEM (${err?.code ?? err?.message ?? 'erro'})`)
    }
    publicKeys.set(k, rsaKey(pub, `JWT_PUBLIC_KEYS '${k}'`))
  }
  return { kid, privateKey, publicKeys }
}

let ring: JwtKeyRing | null = null
function keyRing(): JwtKeyRing {
  return (ring ??= loadJwtKeyRing())
}
/** Testes / troca de chave em runtime. */
export function resetJwtKeyRing(): void {
  ring = null
}
/** Boot: carrega e confere as chaves — o servidor NÃO sobe sem elas. Devolve o resumo para o log (nunca a chave). */
export function assertJwtKeys(): string {
  const r = keyRing()
  return `RS256, kid '${r.kid}'${r.publicKeys.size > 1 ? ` + ${r.publicKeys.size - 1} chave(s) anterior(es)` : ''}`
}

function sign(payload: object, expiresIn: string): string {
  const r = keyRing()
  return jwt.sign(payload, r.privateKey, { algorithm: JWT_ALGORITHM, keyid: r.kid, expiresIn: expiresIn as any })
}

/** Token FINAL (login, seleção, troca de institution). [ttl] menor só para os scripts de prova/smoke do dev. */
export function signFinalToken(p: InstitutionPayload, ttl: string = FINAL_TOKEN_TTL): string {
  return sign({ institutionId: p.institutionId, userId: p.userId, role: p.role, schemaName: p.schemaName }, ttl)
}

export function signSelectionToken(userId: number): string {
  return sign({ userId, scope: SELECTION_SCOPE }, SELECTION_TOKEN_TTL)
}

const unauthorized = (msg: string) => new HttpError(401, msg, undefined, ErrorCodes.UNAUTHORIZED)

/** Verifica assinatura (RS256, `kid` conhecido) e validade. Não confere a FORMA — isso é de quem chama. */
function verified(token: string): Record<string, unknown> {
  const decoded = jwt.decode(String(token ?? ''), { complete: true }) as { header: JwtHeader } | null
  if (!decoded || typeof decoded !== 'object' || !decoded.header) throw unauthorized('Token inválido')
  const kid = decoded.header.kid
  const key = kid ? keyRing().publicKeys.get(kid) : undefined
  if (!key) throw unauthorized('Token inválido')
  try {
    const payload = jwt.verify(token, key, { algorithms: [JWT_ALGORITHM] })
    if (!payload || typeof payload !== 'object') throw unauthorized('Token inválido')
    // gates da A2 (F2A2-ADV-07): validade OBRIGATÓRIA — token sem `exp` (só quem tem a chave forja) nunca vale para sempre
    if (!Number.isFinite((payload as any).exp)) throw unauthorized('Token inválido')
    return payload as Record<string, unknown>
  } catch (err: any) {
    if (err instanceof HttpError) throw err
    throw unauthorized(err?.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido')
  }
}

const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0

/** Token FINAL — a identidade da institution; o token de seleção NÃO serve. Devolve só os 4 campos. */
export function verifyFinalToken(token: string): InstitutionPayload {
  const p = verified(token)
  const ok = p.scope === undefined
    && isPositiveInt(p.institutionId)
    && Number.isSafeInteger(p.userId) && (p.userId as number) >= 0
    && typeof p.role === 'string' && p.role.length > 0
    && typeof p.schemaName === 'string' && SCHEMA_RE.test(p.schemaName)
  if (!ok) throw unauthorized('Token inválido')
  return { institutionId: p.institutionId as number, userId: p.userId as number, role: p.role as string, schemaName: p.schemaName as string }
}

/** Token de SELEÇÃO — só o usuário e a marca; o token final NÃO serve. */
export function verifySelectionToken(token: string): { userId: number } {
  const p = verified(token)
  if (p.scope !== SELECTION_SCOPE || p.institutionId !== undefined || !isPositiveInt(p.userId)) {
    throw unauthorized('Token de seleção inválido')
  }
  return { userId: p.userId as number }
}
