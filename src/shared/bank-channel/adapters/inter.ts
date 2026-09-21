import {
  AdapterContext, BankChargeAdapter, ChargeRegisterInput, ChargeStatus, WebhookInfo,
} from '../types'
import { bankJson, BankHttpError } from '../https-json'

/**
 * Adaptador do BANCO INTER (FEBRABAN 077) — API Cobrança v3 (Boleto com Pix) +
 * OAuth2. Contrato oficial: `Infra-IA/setes-api/integracoes/banco-inter/*.openapi.json`
 * (extraído do portal em 2026-09-19). Só ESTE arquivo conhece o dialeto do Inter;
 * a peça e a composição falam o vocabulário neutro de `types.ts`.
 *
 * Fatos da spec que este adaptador honra:
 *  - token: POST /oauth/v2/token form-urlencoded (client_id, client_secret,
 *    grant_type=client_credentials, scope) sob mTLS; expira em 3600 s; rate limit
 *    5/min → CACHE por canal (renova 60 s antes de vencer; 401 invalida);
 *  - header `x-conta-corrente` (só dígitos da conta + DV) — D-I14;
 *  - emitir é ASSÍNCRONO: 200 {codigoSolicitacao}; `seuNumero` ≤ 15;
 *    `numDiasAgenda` obrigatório (0..60) — D-I19: 60, constante;
 *  - consulta traz situacao/dataSituacao/valorTotalRecebido/origemRecebimento +
 *    boleto{nossoNumero, linhaDigitavel, codigoBarras} + pix{txid, pixCopiaECola};
 *  - cancelar responde 202 (aceite); a confirmação é a consulta;
 *  - PDF vem em {pdf: base64}; sandbox tem /pagar {pagarCom}.
 */

export const INTER_BANK_NUMBER = '077'
export const INTER_NUM_DIAS_AGENDA = 60                 // D-I19
export const INTER_SCOPES = 'boleto-cobranca.read boleto-cobranca.write'
export const INTER_SITUACOES = [
  'EM_PROCESSAMENTO', 'A_RECEBER', 'RECEBIDO', 'MARCADO_RECEBIDO', 'ATRASADO',
  'CANCELADO', 'EXPIRADO', 'FALHA_EMISSAO', 'PROTESTO',
] as const

const HOSTS = {
  P: 'https://cdpj.partners.bancointer.com.br',
  S: 'https://cdpj-sandbox.partners.uatinter.co',
} as const

interface TokenEntry { accessToken: string; expiresAt: number }
const tokenCache = new Map<string, TokenEntry>()
// client_id na chave: trocar a aplicação no PUT /channel invalida o token antigo (LOW do gate)
const cacheKey = (ctx: AdapterContext) =>
  `${ctx.channel.institutionId}:${ctx.channel.bankAccountId}:${ctx.channel.environment}:${ctx.channel.clientId ?? ''}`

/** Testes/reset: esvazia o cache de tokens. */
export function resetInterTokenCache(): void { tokenCache.clear() }

function accountHeader(ctx: AdapterContext): Record<string, string> {
  const digits = `${ctx.channel.accountNumber ?? ''}${ctx.channel.accountNumberDv ?? ''}`.replace(/\D/g, '')
  return digits ? { 'x-conta-corrente': digits } : {}
}

async function getToken(ctx: AdapterContext, force = false): Promise<string> {
  const key = cacheKey(ctx)
  const cached = tokenCache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.accessToken
  if (!ctx.channel.clientId) {
    throw new BankHttpError(409, 'Canal sem client_id configurado', 'BANK_CHANNEL_SECRET_MISSING', 0, '')
  }
  const form = new URLSearchParams({
    client_id: ctx.channel.clientId, client_secret: ctx.secrets.clientSecret,
    grant_type: 'client_credentials', scope: INTER_SCOPES,
  }).toString()
  const { data } = await bankJson<{ access_token: string; expires_in: number }>({
    url: `${HOSTS[ctx.channel.environment]}/oauth/v2/token`, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(form)) },
    body: form, cert: ctx.secrets.cert, key: ctx.secrets.key,
  }, 'inter token')
  if (!data?.access_token) {
    throw new BankHttpError(409, 'Banco não devolveu token', 'BANK_AUTH_FAILED', 200, JSON.stringify(data ?? {}))
  }
  // expires_in ausente/não numérico → 1 h (antes, NaN nunca cacheava: 1 token por chamada, limite 5/min — LOW do gate)
  const rawExpires: unknown = data.expires_in
  const expiresIn = rawExpires !== null && rawExpires !== '' && Number.isFinite(Number(rawExpires)) ? Number(rawExpires) : 3600
  const ttl = Math.max(60, expiresIn - 60) * 1000
  tokenCache.set(key, { accessToken: data.access_token, expiresAt: Date.now() + ttl })
  return data.access_token
}

/** Chamada autenticada com UMA retentativa em 401 (token invalidado). */
async function call<T>(ctx: AdapterContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', pathAndQuery: string, body?: unknown, label = pathAndQuery): Promise<{ status: number; data: T | null }> {
  const run = async (token: string) => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    return bankJson<T>({
      url: `${HOSTS[ctx.channel.environment]}/cobranca/v3${pathAndQuery}`, method,
      headers: {
        // problem+json TAMBÉM: o /pagar do sandbox (204) responde 406 a `Accept: application/json`
        // puro — "Supported types: [application/problem+json]" (smoke 2026-09-21; C7 saía como 500/406)
        Authorization: `Bearer ${token}`, Accept: 'application/json, application/problem+json',
        ...(text ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) } : {}),
        ...accountHeader(ctx),
      },
      body: text, cert: ctx.secrets.cert, key: ctx.secrets.key,
    }, `inter ${label}`)
  }
  // token FORA do bloco que retenta: 401 do próprio /oauth/v2/token (secret errado)
  // propaga na hora — antes gerava 2 chamadas de token por operação (LOW-1 do gate
  // da Onda 2; o sandbox limita o token a 5/min).
  const token = await getToken(ctx, false)
  try {
    return await run(token)
  } catch (err) {
    // só o 401 da CHAMADA (token do cache invalidado pelo banco) refaz UMA vez
    if (err instanceof BankHttpError && err.bankStatus === 401) {
      if (tokenCache.get(cacheKey(ctx))?.accessToken === token) tokenCache.delete(cacheKey(ctx))
      return run(await getToken(ctx, true))
    }
    throw err
  }
}

const money = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v); return Number.isFinite(n) ? n : null
}

function toStatus(raw: any): ChargeStatus {
  const c = raw?.cobranca ?? raw ?? {}
  const b = raw?.boleto ?? {}
  const p = raw?.pix ?? {}
  return {
    requestCode:   String(c.codigoSolicitacao ?? ''),
    reference:     c.seuNumero != null ? String(c.seuNumero) : null,
    status:        String(c.situacao ?? ''),
    statusAt:      c.dataHoraSituacao ?? c.dataSituacao ?? null,
    amount:        money(c.valorNominal),
    paidValue:     money(c.valorTotalRecebido),
    paidBy:        c.origemRecebimento === 'PIX' ? 'PIX' : c.origemRecebimento === 'BOLETO' ? 'BOLETO' : null,
    bankOurNumber: b.nossoNumero ?? c.nossoNumero ?? null,
    digitableLine: b.linhaDigitavel ?? c.linhaDigitavel ?? null,
    barcode:       b.codigoBarras ?? c.codigoBarras ?? null,
    pixCopyPaste:  p.pixCopiaECola ?? c.pixCopiaECola ?? null,
    pixTxid:       p.txid ?? c.txid ?? null,
    cancelReason:  c.motivoCancelamento ?? null,
  }
}

/** Payload do callback do webhook → situação neutra (a composição só usa requestCode; o resto é informativo). */
export function interCallbackToStatus(item: any): ChargeStatus { return toStatus(item) }

function registerBody(input: ChargeRegisterInput) {
  const body: any = {
    seuNumero:      input.reference.slice(0, 15),
    valorNominal:   Number(input.amount.toFixed(2)),
    dataVencimento: input.dueDate,
    numDiasAgenda:  INTER_NUM_DIAS_AGENDA,
    pagador: {
      cpfCnpj:    input.payer.document,
      tipoPessoa: input.payer.personType === 'J' ? 'JURIDICA' : 'FISICA',
      nome:       input.payer.name.slice(0, 100),
      endereco:   input.payer.street.slice(0, 100),
      ...(input.payer.neighborhood ? { bairro: input.payer.neighborhood.slice(0, 60) } : {}),
      cidade:     input.payer.city.slice(0, 60),
      uf:         input.payer.state,
      cep:        input.payer.zipCode,
    },
  }
  if (input.messages?.length) {
    body.mensagem = {}
    input.messages.slice(0, 5).forEach((m, i) => { body.mensagem[`linha${i + 1}`] = m.slice(0, 78) })
  }
  if (input.finePercent && input.finePercent > 0) body.multa = { codigo: 'PERCENTUAL', taxa: input.finePercent }
  if (input.interestMonthly && input.interestMonthly > 0) body.mora = { codigo: 'TAXAMENSAL', taxa: input.interestMonthly }
  if (input.discountPercent && input.discountPercent > 0) {
    body.desconto = { codigo: 'PERCENTUALDATAINFORMADA', taxa: input.discountPercent, quantidadeDias: input.discountDays ?? 0 }
  }
  return body
}

export const interAdapter: BankChargeAdapter = {
  bankNumber: INTER_BANK_NUMBER,

  async register(ctx, input) {
    const { data } = await call<{ codigoSolicitacao: string }>(ctx, 'POST', '/cobrancas', registerBody(input), 'emitir')
    if (!data?.codigoSolicitacao) {
      throw new BankHttpError(422, 'Banco aceitou sem devolver codigoSolicitacao', 'BANK_REJECTED', 200, JSON.stringify(data ?? {}))
    }
    return { requestCode: String(data.codigoSolicitacao) }
  },

  async query(ctx, requestCode) {
    const { data } = await call<any>(ctx, 'GET', `/cobrancas/${encodeURIComponent(requestCode)}`, undefined, 'consultar')
    const st = toStatus(data)
    if (!st.requestCode) st.requestCode = requestCode
    return st
  },

  async cancel(ctx, requestCode, reason) {
    await call(ctx, 'POST', `/cobrancas/${encodeURIComponent(requestCode)}/cancelar`,
      { motivoCancelamento: reason.slice(0, 50) }, 'cancelar')     // 202 = aceite; confirmação pela consulta
  },

  async pdf(ctx, requestCode) {
    const { data } = await call<{ pdf: string }>(ctx, 'GET', `/cobrancas/${encodeURIComponent(requestCode)}/pdf`, undefined, 'pdf')
    if (!data?.pdf) throw new BankHttpError(404, 'Banco não devolveu o PDF', 'BANK_RESOURCE_NOT_FOUND', 200, '')
    return Buffer.from(data.pdf, 'base64')
  },

  async findByReference(ctx, reference, from, to) {
    const q = new URLSearchParams({ dataInicial: from, dataFinal: to, filtrarDataPor: 'EMISSAO', seuNumero: reference, 'paginacao.itensPorPagina': '50' })
    const { data } = await call<any>(ctx, 'GET', `/cobrancas?${q.toString()}`, undefined, 'listar')
    const items: any[] = Array.isArray(data?.cobrancas) ? data.cobrancas : []
    return items.map(toStatus).filter(s => s.reference === reference)
  },

  async webhookGet(ctx) {
    try {
      const { data } = await call<any>(ctx, 'GET', '/cobrancas/webhook', undefined, 'webhook')
      return data?.webhookUrl ? { url: data.webhookUrl, createdAt: data.criacao ?? null, updatedAt: data.atualizacao ?? null } : null
    } catch (err) {
      if (err instanceof BankHttpError && err.bankStatus === 404) return null
      throw err
    }
  },

  async webhookPut(ctx, url) {
    await call(ctx, 'PUT', '/cobrancas/webhook', { webhookUrl: url }, 'webhook put')
  },

  async webhookDelete(ctx) {
    await call(ctx, 'DELETE', '/cobrancas/webhook', undefined, 'webhook delete')
  },

  async paySandbox(ctx, requestCode, via) {
    if (ctx.channel.environment !== 'S') {
      throw new BankHttpError(409, 'Pagamento simulado só existe no sandbox', 'BANK_REJECTED', 0, '')
    }
    await call(ctx, 'POST', `/cobrancas/${encodeURIComponent(requestCode)}/pagar`, { pagarCom: via }, 'pagar sandbox')
  },
}
