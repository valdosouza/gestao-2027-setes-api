import { gzipSync, gunzipSync } from 'zlib'
import { ErrorCodes } from '@shared/errors/error-codes'
import logger from '@shared/logger/logger'
import {
  AuthorityContext, EventRegisterResult, MunicipalTerms, NfseQuery, TaxAuthorityAdapter, TransmitResult,
} from '../types'
import { authorityJson, AuthorityHttpError } from '../https-json'
import { parseEventXml, parseNfseXml, EVENT_CANCEL, CANCEL_EVENT_CODES } from '../dps-builder'

/**
 * Adaptador da SEFIN NACIONAL (ADN / Sistema Nacional NFS-e) — API do Emissor
 * Público (Manual do Contribuinte v1.2, Infra-IA/setes-api/integracoes/nfse-adn/).
 * Só ESTE arquivo conhece o dialeto; a composição fala o vocabulário de types.ts.
 *
 * Fatos que este adaptador honra:
 *  - mTLS com o e-CNPJ A1 (cert/key PEM do contexto), sem token/OAuth;
 *  - JSON por fora, XML GZip+Base64 por dentro (Manual 2022 §6.1 c);
 *  - POST /nfse é SÍNCRONO: 2xx traz a NFS-e gerada, 4xx traz `erros[]` (E0xxx);
 *  - GET /dps/{id} devolve a chave só ao ator da nota; 404 = não gerada;
 *  - POST /nfse/{chave}/eventos é síncrono (aceite/rejeição na resposta);
 *  - GET /parametros_municipais/{cMun}/convenio traz o PAM do município (D-N15).
 *
 * [INCERTO] nomes JSON (`dpsXmlGZipB64`, `nfseXmlGZipB64`, `chaveAcesso`,
 * `pedidoRegistroEventoXmlGZipB64`, `eventoXmlGZipB64`) vêm de fontes
 * secundárias — o swagger oficial exige certificado (README). Por isso a
 * leitura é TOLERANTE: qualquer campo "xml…gzip…b64" é aceito e a chave é
 * lida do próprio XML quando o JSON não a traz.
 */

export const ADN_AUTHORITY = 'ADN' as const

export const ADN_HOSTS = {
  H: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
  P: 'https://sefin.nfse.gov.br/SefinNacional',
} as const

/** Algoritmo de assinatura que o ADN aceita hoje (Manual 2022 §6.1.4 — [INCERTO] até a 1ª sessão). */
export const ADN_SIGN_ALGORITHM = 'sha1' as const

export function gzipB64(xml: string): string {
  return gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
}

export function gunzipB64(b64: string): string {
  return gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')
}

/** Encontra, em qualquer profundidade, valores string de chaves "xml…gzip"/"gzip…b64". */
function collectGzipXmlFields(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => collectGzipXmlFields(n, out, depth + 1)); return out }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' && /(xml.*g?zip|g?zip.*b(ase)?64)/i.test(k) && v.length > 0) out.push(v)
    else if (v && typeof v === 'object') collectGzipXmlFields(v, out, depth + 1)
  }
  return out
}

/** Descomprime tolerando payload não-gzip (alguns retornos podem vir em base64 puro). */
function decodeXmlField(b64: string): string | null {
  try { return gunzipB64(b64) } catch { /* não era gzip */ }
  try {
    const plain = Buffer.from(b64, 'base64').toString('utf8')
    return plain.trimStart().startsWith('<') ? plain : null
  } catch { return null }
}

/** Q-ADV1a: corpo é a resposta ESTRUTURADA do fisco (JSON objeto/lista) — não página de gateway nem vazio. */
function isAuthorityJsonBody(text: string | null | undefined): boolean {
  try { const j = JSON.parse(String(text ?? '')); return !!j && typeof j === 'object' } catch { return false }
}

function unknownResponse(label: string, status: number, text: string): AuthorityHttpError {
  // LOW-6 do gate: nunca a amostra do corpo (pode carregar dado fiscal/segredo) — só tamanho e status
  logger.warn('Fisco respondeu 2xx sem envelope legível', { label, status, bytes: Buffer.byteLength(text, 'utf8') })
  return new AuthorityHttpError(502, `Fisco respondeu ${status} sem envelope legível (${label}) — reconcilie pela consulta antes de reenviar`,
    ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, status, text)
}

async function call<T = any>(ctx: AuthorityContext, method: 'GET' | 'POST', path: string, body?: unknown, label = path, rejectField = 'dps') {
  const text = body === undefined ? undefined : JSON.stringify(body)
  return authorityJson<T>({
    url: `${ADN_HOSTS[ctx.environment]}${path}`, method,
    headers: {
      Accept: 'application/json',
      ...(text ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) } : {}),
    },
    body: text, cert: ctx.cert, key: ctx.key,
  }, `adn ${label}`, { rejectField })
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v))
/** Id do infDPS do XML que ENVIAMOS (a NFS-e devolvida embute o DPS — tem que ser o mesmo). */
function sentDpsIdOf(signedDpsXml: string): string | null {
  return signedDpsXml.match(/<infDPS\b[^>]*\sId="([^"]*)"/)?.[1] ?? null
}
/**
 * Evento GERADO pelo fisco para a chave pedida: tem Id `EVT…` (infEvento) ou `dhProc`, e o
 * `chNFSe` é a chave que perguntamos. O pedido de registro (nosso, ecoado) tem só `dhEvento`.
 */
function isGeneratedEventFor(ev: { eventId: string | null; dhProc: string | null; dhEvento: string | null; accessKey: string | null }, accessKey: string): boolean {
  const generated = !!(ev.eventId || ev.dhProc)
  const key = String(ev.accessKey ?? '').replace(/\D/g, '')
  return generated && key === accessKey && !!(ev.dhProc || ev.dhEvento)
}
/** Chave de acesso da NFS-e = EXATAMENTE 50 dígitos (TSChaveAcesso); qualquer outra coisa não é chave. */
const asAccessKey = (v: unknown): string | null => {
  const s = str(v)?.replace(/\D/g, '') ?? ''
  return s.length === 50 ? s : null
}

export const adnAdapter: TaxAuthorityAdapter = {
  authority: ADN_AUTHORITY,

  async transmit(ctx, signedDpsXml): Promise<TransmitResult> {
    const { status, data, text } = await call<any>(ctx, 'POST', '/nfse', { dpsXmlGZipB64: gzipB64(signedDpsXml) }, 'transmitir')
    const xmlField = collectGzipXmlFields(data)[0]
    const nfseXml = xmlField ? decodeXmlField(xmlField) : null
    if (!nfseXml) throw unknownResponse('transmitir', status, text)
    const parsed = parseNfseXml(nfseXml)
    // ACHADO 5 do gate adversarial: "chave" só é chave com 50 dígitos — fora disso o A
    // nasceria com uma chave que o cancelamento (buildEventId) não aceita → 502, nada gravado.
    // R2-2 (a)(b): a resposta tem que ser AO QUE PEDIMOS — a NFS-e embute o DPS: o Id dele é o
    // que enviamos; e a chave do JSON, quando vem, é a mesma do XML. Resposta trocada
    // (proxy/cache/manutenção) NUNCA vira A da nota errada.
    const jsonKey = asAccessKey(data?.chaveAcesso), xmlKey = asAccessKey(parsed.accessKey)
    if (jsonKey && xmlKey && jsonKey !== xmlKey) throw unknownResponse('transmitir: chave do JSON ≠ chave da NFS-e', status, text)
    const accessKey = xmlKey ?? jsonKey
    if (!accessKey) throw unknownResponse('transmitir: NFS-e sem chave de acesso (50 dígitos)', status, text)
    const sentDpsId = sentDpsIdOf(signedDpsXml)
    if (!parsed.dpsId || parsed.dpsId !== sentDpsId) {
      throw unknownResponse(`transmitir: NFS-e de OUTRO DPS (veio ${parsed.dpsId ?? 'sem Id'}, enviado ${sentDpsId ?? 'sem Id'})`, status, text)
    }
    return {
      accessKey, nfseNumber: parsed.nNFSe, dhProc: parsed.dhProc ?? str(data?.dataHoraProcessamento), nfseXml, raw: data,
    }
  },

  async queryNfse(ctx, accessKey): Promise<NfseQuery> {
    const key = encodeURIComponent(accessKey)
    const { status, data, text } = await call<any>(ctx, 'GET', `/nfse/${key}`, undefined, 'consultar')
    const xmlField = collectGzipXmlFields(data)[0]
    const nfseXml = xmlField ? decodeXmlField(xmlField) : null
    if (!nfseXml) throw unknownResponse('consultar', status, text)
    const parsed = parseNfseXml(nfseXml)
    // R2-2 (c): a NFS-e devolvida tem que ser a da chave PEDIDA — Id de outra chave = resposta trocada
    const xmlKey = asAccessKey(parsed.accessKey)
    if (xmlKey && xmlKey !== accessKey) throw unknownResponse('consultar: NFS-e de OUTRA chave', status, text)
    // R3-6: documento SEM identidade (nem Id do infNFSe nem Id do infDPS) não pode ser conferido contra a
    // pergunta — é ilegível (502), nunca voz; um <e101101> dentro dele viraria C irreversível
    if (!xmlKey && !parsed.dpsId) throw unknownResponse('consultar: NFS-e sem identidade (sem Id do infNFSe nem do infDPS)', status, text)
    const base: NfseQuery = { accessKey, status: 'authorized', nfseXml, dhProc: parsed.dhProc }
    if (parsed.cancelled) return { ...base, status: 'cancelled', cancelled: { dhEvento: parsed.cancelled.dhEvento, motive: parsed.cancelled.xMotivo } }

    // cStat (100/102/103/107) NÃO expressa cancelamento: a situação vem dos EVENTOS da chave.
    // [INCERTO] formato do GET /nfse/{chave}/eventos (lista de XML gzip+b64?) — leitura tolerante;
    // 404 = nenhum evento; 2xx ilegível = 'unknown' (nunca inventa "autorizada").
    let ev: { status: number; data: any; text: string }
    try {
      ev = await call<any>(ctx, 'GET', `/nfse/${key}/eventos`, undefined, 'eventos')
    } catch (err) {
      if (err instanceof AuthorityHttpError && err.authorityStatus === 404) return base
      throw err
    }
    if (ev.data === null) return ev.text.trim() ? { ...base, status: 'unknown' } : base
    const xmls = collectGzipXmlFields(ev.data).map(decodeXmlField).filter((x): x is string => !!x)
    if (!xmls.length) {
      const empty = Array.isArray(ev.data) ? ev.data.length === 0
        : Array.isArray(ev.data?.eventos) ? ev.data.eventos.length === 0
        : Object.keys(ev.data ?? {}).length === 0
      return empty ? base : { ...base, status: 'unknown' }
    }
    // R2-2 (d): só evento GERADO (Id EVT + dhProc) e DESTA chave cancela — evento de outra NFS-e na
    // lista (resposta trocada) não é voz sobre esta; pedido ecoado (sem Id/dhProc) tampouco
    const found = xmls.map(x => ({ xml: x, ev: parseEventXml(x) })).find(({ ev: e }) =>
      !!e.eventCode && CANCEL_EVENT_CODES.has(e.eventCode) && isGeneratedEventFor(e, accessKey))
    if (!found) return base
    const cancel = found.ev
    return { ...base, status: 'cancelled', cancelled: { dhEvento: cancel.dhProc ?? cancel.dhEvento, motive: cancel.xMotivo, eventXml: found.xml } }
  },

  async queryDpsAccessKey(ctx, dpsId): Promise<string | null> {
    try {
      const { status, data, text } = await call<any>(ctx, 'GET', `/dps/${encodeURIComponent(dpsId)}`, undefined, 'dps')
      const key = asAccessKey(data?.chaveAcesso) ?? asAccessKey(data?.chave) ?? (text.match(/\b\d{50}\b/)?.[0] ?? null)
      if (!key) throw unknownResponse('dps', status, text)
      return key
    } catch (err) {
      // Q-ADV1a (Valdo 2026-09-30): 404 só é "DPS sem NFS-e" (conclusivo → F) quando é a RESPOSTA do fisco
      // (corpo JSON estruturado); 404 vazio/HTML (gateway, proxy, rota) é ilegível → 502, a tentativa fica em voo
      if (err instanceof AuthorityHttpError && err.authorityStatus === 404) {
        if (isAuthorityJsonBody(err.body)) return null
        throw unknownResponse('dps: 404 sem resposta estruturada do fisco', 404, err.body)
      }
      throw err
    }
  },

  async registerEvent(ctx, accessKey, signedEventXml): Promise<EventRegisterResult> {
    // [INCERTO] nome do campo do pedido — sem confirmação no manual v1.2; FAQ 17.1 cita "eventoViaXmlGZipBase64"
    // para outro canal. Fica `pedidoRegistroEventoXmlGZipB64` até o swagger com certificado dizer.
    const { status, data, text } = await call<any>(ctx, 'POST', `/nfse/${encodeURIComponent(accessKey)}/eventos`,
      { pedidoRegistroEventoXmlGZipB64: gzipB64(signedEventXml) }, 'evento', 'event')
    // ACHADO 1 (HIGH) do gate adversarial: 2xx SEM o evento gerado (corpo vazio, JSON sem XML,
    // 204, HTML de proxy/WAF) NÃO é aceite — o fisco pode ter cancelado ou não. Devolver
    // `{ dhEvento: null }` fazia a composição gravar C + cancelar localmente sem a voz
    // (D-N7 furada). Ambíguo = 502 → K em voo; a consulta reconcilia (C ou N).
    // R2-1: "aceite" = evento GERADO pelo fisco (infEvento/@Id EVT… ou dhProc), do TIPO pedido
    // (e101101) e DESTA chave — o eco do nosso próprio pedido (pedRegEvento tem e101101 + dhEvento,
    // mas nem Id EVT nem dhProc), evento de outra NFS-e ou de outro tipo NÃO são resposta ao pedido.
    const xml = collectGzipXmlFields(data).map(decodeXmlField).find(x => !!x) ?? null
    const ev = xml ? parseEventXml(xml) : null
    if (!ev || ev.eventCode !== EVENT_CANCEL || !isGeneratedEventFor(ev, accessKey)) {
      throw unknownResponse('evento: resposta sem o evento gerado para esta chave', status, text)
    }
    return { dhEvento: ev.dhProc ?? ev.dhEvento!, protocol: ev.eventId ?? null, eventXml: xml, raw: data }
  },

  async municipalTerms(ctx, cMun): Promise<MunicipalTerms> {
    const { data } = await call<any>(ctx, 'GET', `/parametros_municipais/${encodeURIComponent(cMun)}/convenio`, undefined, 'convenio')
    return { cancelDays: findCancelDays(data), raw: data }
  },
}

/** Prazo de cancelamento no JSON do convênio — chave com "cancel" e valor numérico, em qualquer nível [INCERTO]. */
export function findCancelDays(node: unknown, depth = 0): number | null {
  if (depth > 4 || node === null || typeof node !== 'object') return null
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (/cancel/i.test(k) && /prazo|dias|days|limite/i.test(k) && v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (/^prazoCancelamento/i.test(k) && Number.isFinite(Number(v))) return Number(v)
    if (v && typeof v === 'object') { const r = findCancelDays(v, depth + 1); if (r !== null) return r }
  }
  return null
}
