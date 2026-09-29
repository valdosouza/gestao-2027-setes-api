import https from 'https'
import { URL } from 'url'
import { FieldError, HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import logger from '@shared/logger/logger'

/**
 * Transporte HTTPS com mTLS para os adaptadores fiscais — `https.request`
 * nativo com `cert`/`key` PEM (o cofre guarda o par derivado do .pfx — D-N5).
 * Molde: @shared/bank-channel/https-json.ts (Onda 2). Sem dependência nova.
 *
 * Tradução de falhas (fronteira ÚNICA — a composição nunca vê socket):
 *  - rede/timeout/5xx/429   → 503 FISCAL_AUTHORITY_UNAVAILABLE ("tente depois"; nada mudou)
 *  - handshake mTLS/401/403 → 409 FISCAL_AUTHORITY_AUTH_FAILED (é CREDENCIAL, não indisponibilidade —
 *                             mesma lição da Onda 2: "tente de novo" só empilha tentativas)
 *  - 404                    → 404 FISCAL_NFSE_NOT_FOUND
 *  - 4xx demais             → 422 FISCAL_DPS_REJECTED com os E0xxx do fisco em fields[]
 *  - 2xx ilegível           → cabe ao adaptador (502 FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
 */

export interface HttpsCall {
  url:      string
  method:   'GET' | 'POST' | 'HEAD'
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

/** Fisco é mais lento que banco: validação + geração síncrona da NFS-e. */
export const DEFAULT_TIMEOUT_MS = 30_000

export class AuthorityHttpError extends HttpError {
  constructor(
    statusCode: number, message: string, code: string,
    /** Status HTTP que o fisco respondeu (0 = não chegou a responder). */
    public readonly authorityStatus: number,
    /** Corpo cru da resposta (texto) — para log/voz do fisco; nunca contém segredo nosso. */
    public readonly body: string,
    fields?: FieldError[],
  ) {
    super(statusCode, message, fields, code)
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

/**
 * Transporte injetável: os testes trocam `transport.request` sem abrir socket;
 * produção usa o `httpsRequest` acima.
 */
export const transport: { request: (call: HttpsCall) => Promise<HttpsResult> } = { request: httpsRequest }

/**
 * Códigos do Node/OpenSSL que só acontecem por certificado/chave errados no
 * handshake. Cópia deliberada da lista do bank-channel: peça não importa peça
 * (candidato a unificar num @shared/https-mtls quando o 3º consumidor surgir).
 */
const TLS_CREDENTIAL_CODES = new Set([
  'EPROTO', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_OSSL_PEM_NO_START_LINE', 'ERR_OSSL_PEM_BAD_END_LINE', 'ERR_OSSL_EVP_BAD_DECRYPT',
  'ERR_OSSL_X509_KEY_VALUES_MISMATCH', 'ERR_OSSL_UNSUPPORTED', 'ERR_OSSL_ASN1_WRONG_TAG',
])
/**
 * D-N30 (MEDIUM-4 do socrático): falha de credencial LOCAL — o par PEM não abre/não casa
 * ANTES de qualquer byte chegar ao fisco (cert novo + key velha numa corrida de upload,
 * PEM ilegível). Não é voz do fisco: vira 409 FISCAL_CERT_INVALID e NADA é gravado na nota.
 */
const LOCAL_CREDENTIAL_CODES = new Set([
  'ERR_OSSL_PEM_NO_START_LINE', 'ERR_OSSL_PEM_BAD_END_LINE', 'ERR_OSSL_EVP_BAD_DECRYPT',
  'ERR_OSSL_X509_KEY_VALUES_MISMATCH', 'ERR_OSSL_UNSUPPORTED', 'ERR_OSSL_ASN1_WRONG_TAG',
])
export function isLocalCredentialError(err: any): boolean {
  const code = String(err?.code ?? '')
  if (LOCAL_CREDENTIAL_CODES.has(code) || code.startsWith('ERR_OSSL_')) return true
  return /PEM routines|key values mismatch/i.test(String(err?.message ?? ''))
}
export function isTlsCredentialError(err: any): boolean {
  const code = String(err?.code ?? '')
  if (TLS_CREDENTIAL_CODES.has(code) || code.startsWith('ERR_OSSL_') || code.startsWith('ERR_TLS_')) return true
  return /SSL routines|tlsv1 alert|certificate|PEM routines|key values mismatch/i.test(String(err?.message ?? ''))
}

/**
 * Lista de rejeições do corpo do fisco. Formato assumido [INCERTO — só o
 * swagger com certificado confirma]: `{ erros: [{ codigo, descricao, complemento }] }`.
 * Tolerante a `errors[]`, `mensagens[]`, `{ codigo|code, descricao|mensagem|message }`.
 */
export function authorityRejections(text: string): { code: string; message: string }[] {
  let j: any
  try { j = JSON.parse(text) } catch {
    // sonda 2026-09-22: o 403 do gateway do fisco vem em HTML — nunca repassar tags ao usuário/log
    const plain = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    return plain ? [{ code: '', message: plain.slice(0, 160) }] : []
  }
  const list: any[] = Array.isArray(j) ? j
    : Array.isArray(j?.erros) ? j.erros
    : Array.isArray(j?.errors) ? j.errors
    : Array.isArray(j?.mensagens) ? j.mensagens
    : (j && typeof j === 'object' && (j.codigo || j.code || j.mensagem || j.message || j.descricao)) ? [j]
    : []
  return list.map(e => {
    if (typeof e === 'string') return { code: '', message: e.slice(0, 255) }
    const code = String(e?.codigo ?? e?.code ?? e?.Codigo ?? '').trim()
    const desc = String(e?.descricao ?? e?.Descricao ?? e?.mensagem ?? e?.message ?? e?.detail ?? '').trim()
    const compl = String(e?.complemento ?? e?.Complemento ?? '').trim()
    return { code, message: (compl ? `${desc} (${compl})` : desc).slice(0, 255) }
  })
}

/** Uma linha legível com todas as rejeições ("E0718: … — E0001: …"). */
export function rejectionsMessage(items: { code: string; message: string }[], fallback: string): string {
  const s = items.map(i => (i.code ? `${i.code}: ${i.message}` : i.message)).filter(Boolean).join(' — ')
  return (s || fallback).slice(0, 255)
}

export interface AuthorityCallOptions {
  /** Nome do campo em fields[] quando o fisco rejeita ('dps' | 'event' …). */
  rejectField?: string
}

/**
 * Chamada JSON com a tradução de falhas da fronteira. Devolve `{ status, data,
 * text }`: `data` é o JSON parseado (null se vazio/ilegível — o adaptador decide
 * se isso é resposta desconhecida).
 */
export async function authorityJson<T = any>(call: HttpsCall, label: string, opts: AuthorityCallOptions = {}): Promise<{ status: number; data: T | null; text: string }> {
  let res: HttpsResult
  try {
    res = await transport.request(call)
  } catch (err: any) {
    if (isLocalCredentialError(err)) {
      logger.warn('Par PEM do emissor recusado LOCALMENTE (antes do fisco)', { label, code: err?.code, err: err?.message })
      throw new AuthorityHttpError(409, 'Certificado/chave do emissor no cofre não abrem (par inconsistente ou ilegível) — envie o .pfx novamente',
        ErrorCodes.FISCAL_CERT_INVALID, 0, String(err?.code ?? ''), [{ field: 'certificate', message: 'Par PEM inválido' }])
    }
    if (isTlsCredentialError(err)) {
      logger.warn('Fisco recusou o certificado do emissor (TLS)', { label, url: call.url, code: err?.code, err: err?.message })
      throw new AuthorityHttpError(409, 'Fisco recusou o certificado/chave do emissor (mTLS) — confira o A1 na aba Emissor fiscal',
        ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED, 0, String(err?.code ?? ''))
    }
    logger.warn('Fisco indisponível', { label, url: call.url, code: err?.code, err: err?.message })
    throw new AuthorityHttpError(503, 'Fisco indisponível no momento — tente novamente em alguns minutos',
      ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, 0, '')
  }
  if (res.status >= 200 && res.status < 300) {
    if (!res.text.trim()) return { status: res.status, data: null, text: res.text }
    try { return { status: res.status, data: JSON.parse(res.text) as T, text: res.text } }
    catch { return { status: res.status, data: null, text: res.text } }
  }
  const items = authorityRejections(res.text)
  const msg = rejectionsMessage(items, '')
  if (res.status >= 500 || res.status === 429) {
    logger.warn('Fisco respondeu 5xx/429', { label, status: res.status, msg })
    throw new AuthorityHttpError(503, `Fisco indisponível (${res.status}) — tente novamente em alguns minutos`,
      ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, res.status, res.text)
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthorityHttpError(409, `Fisco recusou a autenticação (${res.status}): ${msg || 'certificado não aceito para este CNPJ/ambiente'}`,
      ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED, res.status, res.text)
  }
  if (res.status === 404) {
    throw new AuthorityHttpError(404, `Fisco não encontrou o recurso: ${msg || label}`,
      ErrorCodes.FISCAL_NFSE_NOT_FOUND, res.status, res.text)
  }
  // 400/409/422…: recusa de REGRA — os E0xxx vão em fields[] para a tela e para a voz do fisco
  const field = opts.rejectField ?? 'dps'
  const fields: FieldError[] = items.length
    ? items.map(i => ({ field, message: i.code ? `${i.code}: ${i.message}` : i.message }))
    : [{ field, message: `Fisco recusou (${res.status}) sem detalhar` }]
  throw new AuthorityHttpError(422, `Fisco rejeitou (${res.status}): ${msg || 'sem detalhe'}`,
    ErrorCodes.FISCAL_DPS_REJECTED, res.status, res.text, fields)
}
