import https from 'https'
import { URL } from 'url'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

/**
 * Transporte HTTPS com mTLS para os adaptadores — `https.request` nativo com
 * `cert`/`key` (o certificado do Inter é PEM: entra direto, sem conversão).
 * Sem dependência nova. Timeout curto e explícito: banco lento não pode
 * segurar a conexão do pool nem a requisição do operador.
 *
 * Tradução de falhas (fronteira ÚNICA — a composição nunca vê socket):
 *  - rede/timeout/5xx → 503 BANK_UNAVAILABLE ("tente depois"; D-I8 fail-closed)
 *  - 401/403           → 409 BANK_AUTH_FAILED (credencial/escopo/certificado)
 *  - 404               → 404 BANK_RESOURCE_NOT_FOUND
 *  - 4xx demais        → 422 BANK_REJECTED com a mensagem do banco (violações)
 */

export interface HttpsCall {
  url:      string
  method:   'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?:    string
  cert?:    Buffer
  key?:     Buffer
  timeoutMs?: number
}

export interface HttpsResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}

export const DEFAULT_TIMEOUT_MS = 15_000

export class BankHttpError extends HttpError {
  constructor(statusCode: number, message: string, code: string, public readonly bankStatus: number, public readonly bankBody: string) {
    super(statusCode, message, undefined, code)
  }
}

export function httpsRequest(call: HttpsCall): Promise<HttpsResult> {
  const u = new URL(call.url)
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: call.method,
      headers: call.headers, cert: call.cert, key: call.key,
      timeout: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('error', reject)                                   // reset no meio do corpo: nunca pendente
      res.on('end', () => resolve({
        status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (call.body) req.write(call.body)
    req.end()
  })
}

/** Mensagem legível do corpo de erro do banco (Inter: title/detail/violacoes[]). */
export function bankErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text)
    const parts: string[] = []
    if (j.title) parts.push(String(j.title))
    if (j.detail) parts.push(String(j.detail))
    if (j.message) parts.push(String(j.message))
    if (Array.isArray(j.violacoes)) {
      for (const v of j.violacoes) parts.push([v.propriedade, v.razao].filter(Boolean).join(': '))
    }
    if (Array.isArray(j.erros)) for (const e of j.erros) parts.push(String(e.mensagem ?? e))
    return parts.join(' — ').slice(0, 255) || text.slice(0, 255)
  } catch {
    return text.slice(0, 255)
  }
}

/**
 * Chamada JSON com a tradução de falhas da fronteira. `ok` = 2xx; devolve o
 * corpo parseado (ou null para 202/204).
 */
/**
 * Transporte injetável: os testes do adaptador trocam `transport.request` sem
 * abrir socket; produção usa o `httpsRequest` acima.
 */
export const transport: { request: (call: HttpsCall) => Promise<HttpsResult> } = { request: httpsRequest }

/** Códigos do Node/OpenSSL que só acontecem por certificado/chave errados no handshake. */
const TLS_CREDENTIAL_CODES = new Set([
  'EPROTO', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_OSSL_PEM_NO_START_LINE', 'ERR_OSSL_PEM_BAD_END_LINE', 'ERR_OSSL_EVP_BAD_DECRYPT',
  'ERR_OSSL_X509_KEY_VALUES_MISMATCH', 'ERR_OSSL_UNSUPPORTED', 'ERR_OSSL_ASN1_WRONG_TAG',
])
export function isTlsCredentialError(err: any): boolean {
  const code = String(err?.code ?? '')
  if (TLS_CREDENTIAL_CODES.has(code) || code.startsWith('ERR_OSSL_') || code.startsWith('ERR_TLS_')) return true
  return /SSL routines|tlsv1 alert|certificate|PEM routines|key values mismatch/i.test(String(err?.message ?? ''))
}

export async function bankJson<T = any>(call: HttpsCall, label: string): Promise<{ status: number; data: T | null }> {
  let res: HttpsResult
  try {
    res = await transport.request(call)
  } catch (err: any) {
    if (isTlsCredentialError(err)) {
      // handshake mTLS recusado (CA desconhecida, chave ≠ certificado, PEM ilegível,
      // vencido): é CREDENCIAL do canal, não indisponibilidade — "tente de novo"
      // só empilhava tentativas F (sonda ao vivo do gate da Onda 2, A2).
      logger.warn('Banco recusou o certificado do canal (TLS)', { label, url: call.url, code: err?.code, err: err?.message })
      throw new BankHttpError(409, 'Banco recusou o certificado/chave do canal (mTLS) — confira os segredos na aba Canal API', 'BANK_AUTH_FAILED', 0, String(err?.code ?? ''))
    }
    logger.warn('Banco indisponível', { label, url: call.url, code: err?.code, err: err?.message })
    throw new BankHttpError(503, 'Banco indisponível no momento — tente novamente em alguns minutos', 'BANK_UNAVAILABLE', 0, '')
  }
  if (res.status >= 200 && res.status < 300) {
    if (!res.text.trim()) return { status: res.status, data: null }
    try { return { status: res.status, data: JSON.parse(res.text) as T } } catch { return { status: res.status, data: null } }
  }
  const msg = bankErrorMessage(res.text)
  if (res.status >= 500) {
    logger.warn('Banco respondeu 5xx', { label, status: res.status, msg })
    throw new BankHttpError(503, `Banco indisponível (${res.status}) — tente novamente em alguns minutos`, 'BANK_UNAVAILABLE', res.status, res.text)
  }
  if (res.status === 401 || res.status === 403) {
    throw new BankHttpError(409, `Banco recusou a autenticação (${res.status}): ${msg || 'credencial, escopo ou certificado'}`, 'BANK_AUTH_FAILED', res.status, res.text)
  }
  if (res.status === 404) {
    throw new BankHttpError(404, `Banco não encontrou o recurso: ${msg || label}`, 'BANK_RESOURCE_NOT_FOUND', res.status, res.text)
  }
  if (res.status === 429) {
    throw new BankHttpError(503, 'Limite de chamadas do banco atingido — tente novamente em 1 minuto', 'BANK_RATE_LIMITED', res.status, res.text)
  }
  throw new BankHttpError(422, `Banco recusou (${res.status}): ${msg}`, 'BANK_REJECTED', res.status, res.text)
}
