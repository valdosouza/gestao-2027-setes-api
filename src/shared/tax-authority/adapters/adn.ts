import { gzipSync, gunzipSync } from 'zlib'
import { ErrorCodes } from '@shared/errors/error-codes'
import logger from '@shared/logger/logger'
import {
  AuthorityContext, EventRegisterResult, MunicipalTerms, NfseQuery, TaxAuthorityAdapter, TransmitResult,
} from '../types'
import { authorityJson, AuthorityHttpError } from '../https-json'
import { tagAmbiguous, AmbiguousCause } from '../ambiguous-cause'
import { parseEventXml, parseNfseXml, firstText, EVENT_CANCEL, CANCEL_EVENT_CODES } from '../dps-builder'

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

/**
 * Q-ADV1a/Q-ADV2b/Q-ADV2f (Valdo 2026-09-30): 404 do `GET /dps/{id}` só é "o fisco não gerou NFS-e
 * para este DPS" quando o FISCO diz isso — código **E2404**. Forma REAL (sonda na produção restrita,
 * 2026-09-30): `{"tipoAmbiente":…,"dataHoraProcessamento":…,"erro":{"codigo":"E2404","descricao":"Não foi
 * gerada uma NFS-e com o identificador de DPS informado"}}` — `erro` no SINGULAR. Aceita também a lista
 * (`erros[]`/`errors[]`) e o código no topo; qualquer outro 404 (gateway, rota, JSON sem E2404, HTML,
 * vazio) é ambíguo → 502, a tentativa fica em voo.
 */
export const DPS_NOT_GENERATED_CODE = 'E2404'
function isDpsNotGenerated(text: string | null | undefined, environment: 'H' | 'P'): boolean {
  let j: any
  try { j = JSON.parse(String(text ?? '')) } catch { return false }
  if (!j || typeof j !== 'object') return false
  // R16-03 do gate da Rodada 16 (a regra do L8 aplicada ao E2404): com a D-F90 o E2404 virou a PROVA que libera o cancelamento
  // local — envelope que diz o OUTRO ambiente (1 = P, 2 = H) é ambíguo. ⚠️ A forma REAL do E2404 (sonda 2026-09-30, Q-ADV2f) traz
  // `"tipoAmbiente":0` — 0/ausente/qualquer outro valor NÃO afirma ambiente e segue aceito (recusá-lo quebraria a produção)
  const amb = !Array.isArray(j) ? Number(j.tipoAmbiente) : NaN
  if ((amb === 1 || amb === 2) && amb !== (environment === 'P' ? 1 : 2)) return false
  const items: any[] = [
    ...(Array.isArray(j) ? j : [j]),
    ...(j.erro && typeof j.erro === 'object' ? [j.erro] : []),
    ...(Array.isArray(j.erros) ? j.erros : []),
    ...(Array.isArray(j.errors) ? j.errors : []),
  ]
  return items.some(e => e && typeof e === 'object' && String(e.codigo ?? e.Codigo ?? '').trim().toUpperCase() === DPS_NOT_GENERATED_CODE)
}

/** D-F98 (= Q-F104 (b)): todo ambíguo do adaptador nasce com a CAUSA da lista fechada — é ela que vai ao alarme; o `label` (só texto
 *  NOSSO, nunca valor da resposta — D-F98 (c)) fica no warn do adaptador. */
function unknownResponse(cause: AmbiguousCause, label: string, status: number, text: string): AuthorityHttpError {
  // LOW-6 do gate: nunca a amostra do corpo (pode carregar dado fiscal/segredo) — só tamanho e status
  logger.warn('Fisco respondeu 2xx sem envelope legível', { label, status, bytes: Buffer.byteLength(text, 'utf8') })
  return tagAmbiguous(new AuthorityHttpError(502, `Fisco respondeu ${status} sem envelope legível (${label}) — reconcilie pela consulta antes de reenviar`,
    ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, status, text), cause)
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
/**
 * D-F89: o que distingue dois eventos do mesmo tipo — iguais nisso = repetição da mesma voz; diferentes = contradição.
 * D-F93 (= Q-F99 (a), Valdo 2026-10-11): somados `nDFSe`, o autor (`CNPJAutor`/`CPFAutor`), `ambGer` e `tpAmb` — os campos que o
 * fisco preenche no evento; divergência FORA dos 8 da D-F89 decidia, pela ordem da lista, qual XML ia para o arquivo (R16-01).
 * D-F96 (= Q-F102 (a), Valdo 2026-10-11): lidos pelo MESMO leitor do parse (`firstText` — atributos e escapes iguais aos do resto do
 * adaptador); o leitor próprio deixava atributo/CDATA divergentes passarem como repetição (R17-01).
 */
const eventSignature = (e: ReturnType<typeof parseEventXml>, xml: string): string =>
  JSON.stringify([e.eventCode, e.eventId, e.dhProc, e.dhEvento, e.nSeqEvento, e.cMotivo, e.xMotivo, e.substituteKey ?? null,
    firstText(xml, 'nDFSe'), firstText(xml, 'CNPJAutor') ?? firstText(xml, 'CPFAutor'), firstText(xml, 'ambGer'), firstText(xml, 'tpAmb')])
/** Chave de acesso da NFS-e = EXATAMENTE 50 dígitos (TSChaveAcesso); qualquer outra coisa não é chave. */
const asAccessKey = (v: unknown): string | null => {
  const s = str(v)?.replace(/\D/g, '') ?? ''
  return s.length === 50 ? s : null
}

/**
 * D-F61 (= Q-F68 (a), Valdo 2026-10-10) — 404 que É a voz da Sefin "não há esse evento": o envelope JSON dela
 * (`versaoAplicativo` + `tipoAmbiente`) sem `eventos` e sem `erro` — forma cravada ao vivo em H (prompt das APIs fiscais §21.2).
 * 404 em HTML (rota inexistente, gateway) ou JSON de outra forma NÃO é: ambíguo — molde do E2404 do `GET /dps` (Q-ADV2f).
 */
function isSefinNoEventEnvelope(text: string, environment: 'H' | 'P'): boolean {
  let j: any
  try { j = JSON.parse(text) } catch { return false }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false
  if (j.erro !== undefined || j.erros !== undefined || j.eventos !== undefined) return false
  // gates do delta (L8): o envelope é do AMBIENTE perguntado — 1 = produção, 2 = homologação (cravado: H=2, P=1)
  return typeof j.versaoAplicativo === 'string' && j.versaoAplicativo.length > 0 && Number(j.tipoAmbiente) === (environment === 'P' ? 1 : 2)
}

/**
 * D-F61 — o `arquivoXml` do evento vem como base64 do TEXTO gzip+base64 (duas camadas — cravado ao vivo em H); tolera uma
 * camada (gzip+b64 ou XML em b64) e XML cru. Ilegível = null.
 */
function decodeEventFile(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return null
  if (s.startsWith('<')) return s
  const once = decodeXmlField(s)
  if (once) return once
  try {
    const inner = Buffer.from(s, 'base64').toString('utf8').trim()
    return /^[A-Za-z0-9+/=\r\n]+$/.test(inner) ? decodeXmlField(inner) : null
  } catch { return null }
}

/**
 * D-F61 — eventos de UM código de cancelamento da chave: `GET /nfse/{chave}/eventos/{tipo}/1` (o cancelamento é único por nota
 * — sequência 1). `GET /nfse/{chave}/eventos` (sem tipo) NÃO existe na Sefin (405, Allow: POST). `null` = a Sefin disse que não
 * há esse evento; lista = os XML dos eventos; qualquer outra resposta = 502 ambíguo (nunca voz).
 */
async function cancelEventXmls(ctx: AuthorityContext, key: string, code: string): Promise<string[] | null> {
  let res: { status: number; data: any; text: string }
  try {
    res = await call<any>(ctx, 'GET', `/nfse/${key}/eventos/${encodeURIComponent(code)}/1`, undefined, 'eventos')
  } catch (err) {
    if (err instanceof AuthorityHttpError && err.authorityStatus === 404) {
      if (isSefinNoEventEnvelope(err.body, ctx.environment)) return null
      // M5 dos gates: contrato do fisco DIVERGENTE do cravado — log de ERRO próprio (o alarme por padrão de log é da F3)
      logger.error('Contrato da Sefin divergente: 404 de evento fora do envelope cravado', { code, environment: ctx.environment, bytes: Buffer.byteLength(err.body ?? '', 'utf8') })
      throw unknownResponse('evento-fora-do-contrato', `eventos ${code}: 404 fora do envelope da Sefin`, 404, err.body)
    }
    // D-F65 (= Q-F72 (a), Valdo 2026-10-10): 401/403 numa rota de EVENTO depois do 200 do GET /nfse da MESMA nota (mesmo
    // certificado) é falha DESTA nota, não do emissor — 502 ambíguo: o rodízio carimba e segue (antes parava a passada para sempre)
    if (err instanceof AuthorityHttpError && (err.authorityStatus === 401 || err.authorityStatus === 403)) {
      logger.error('Fisco recusou a rota de EVENTO depois de aceitar o GET da NFS-e (mesmo certificado)', { code, environment: ctx.environment, status: err.authorityStatus })
      throw tagAmbiguous(new AuthorityHttpError(502, `Fisco recusou (${err.authorityStatus}) a consulta do evento ${code} desta NFS-e — situação ambígua; a próxima consulta pergunta de novo`,
        ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, err.authorityStatus, err.body), 'evento-recusado')
    }
    throw err
  }
  const items = Array.isArray(res.data?.eventos) ? res.data.eventos : null
  if (!items) throw unknownResponse('evento-fora-do-contrato', `eventos ${code}: 2xx sem a lista de eventos`, res.status, res.text)
  // D-F63: 200 com lista VAZIA não é forma cravada (sem evento a Sefin responde 404) — ambíguo
  if (!items.length) throw unknownResponse('evento-fora-do-contrato', `eventos ${code}: 2xx com a lista vazia`, res.status, res.text)
  return items
    .map((it: any) => decodeEventFile(it?.arquivoXml) ?? collectGzipXmlFields(it).map(decodeXmlField).find((x): x is string => !!x) ?? null)
    .filter((x: string | null): x is string => !!x)
}

export const adnAdapter: TaxAuthorityAdapter = {
  authority: ADN_AUTHORITY,

  async transmit(ctx, signedDpsXml): Promise<TransmitResult> {
    const { status, data, text } = await call<any>(ctx, 'POST', '/nfse', { dpsXmlGZipB64: gzipB64(signedDpsXml) }, 'transmitir')
    const xmlField = collectGzipXmlFields(data)[0]
    const nfseXml = xmlField ? decodeXmlField(xmlField) : null
    if (!nfseXml) throw unknownResponse('envelope-ilegivel', 'transmitir', status, text)
    // gate R19 (S5 — mesma classe do R18-07): XML que o leitor não lê → ambíguo (502), nunca exceção crua (500, sem alarme)
    let parsed: ReturnType<typeof parseNfseXml>
    try { parsed = parseNfseXml(nfseXml) } catch { throw unknownResponse('nfse-ilegivel', 'transmitir: NFS-e ilegível', status, text) }
    // ACHADO 5 do gate adversarial: "chave" só é chave com 50 dígitos — fora disso o A
    // nasceria com uma chave que o cancelamento (buildEventId) não aceita → 502, nada gravado.
    // R2-2 (a)(b): a resposta tem que ser AO QUE PEDIMOS — a NFS-e embute o DPS: o Id dele é o
    // que enviamos; e a chave do JSON, quando vem, é a mesma do XML. Resposta trocada
    // (proxy/cache/manutenção) NUNCA vira A da nota errada.
    const jsonKey = asAccessKey(data?.chaveAcesso), xmlKey = asAccessKey(parsed.accessKey)
    if (jsonKey && xmlKey && jsonKey !== xmlKey) throw unknownResponse('nfse-chave-divergente', 'transmitir: chave do JSON ≠ chave da NFS-e', status, text)
    const accessKey = xmlKey ?? jsonKey
    if (!accessKey) throw unknownResponse('nfse-sem-chave', 'transmitir: NFS-e sem chave de acesso (50 dígitos)', status, text)
    const sentDpsId = sentDpsIdOf(signedDpsXml)
    if (!parsed.dpsId || parsed.dpsId !== sentDpsId) {
      // D-F98 (c) (= Q-F104, Valdo 2026-10-11): o Id que VEIO é de TERCEIRO (embute o CPF/CNPJ dele) — nunca na mensagem nem no log
      throw parsed.dpsId
        ? unknownResponse('nfse-de-outro-dps', 'transmitir: NFS-e de OUTRO DPS (Id divergente do enviado)', status, text)
        : unknownResponse('nfse-sem-identidade', 'transmitir: NFS-e sem o Id do DPS', status, text)
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
    if (!nfseXml) throw unknownResponse('envelope-ilegivel', 'consultar', status, text)
    // R18-07 do gate da Rodada 18: XML que o leitor não consegue ler (entidade inválida, etc.) é ILEGÍVEL — 502 ambíguo, nunca 500 cru
    let parsed: ReturnType<typeof parseNfseXml>
    try { parsed = parseNfseXml(nfseXml) } catch { throw unknownResponse('nfse-ilegivel', 'consultar: NFS-e ilegível', status, text) }
    // R2-2 (c): a NFS-e devolvida tem que ser a da chave PEDIDA — Id de outra chave = resposta trocada
    const xmlKey = asAccessKey(parsed.accessKey)
    if (xmlKey && xmlKey !== accessKey) throw unknownResponse('nfse-chave-divergente', 'consultar: NFS-e de OUTRA chave', status, text)
    // R3-6: documento SEM identidade (nem Id do infNFSe nem Id do infDPS) não pode ser conferido contra a
    // pergunta — é ilegível (502), nunca voz; um <e101101> dentro dele viraria C irreversível
    if (!xmlKey && !parsed.dpsId) throw unknownResponse('nfse-sem-identidade', 'consultar: NFS-e sem identidade (sem Id do infNFSe nem do infDPS)', status, text)
    const base: NfseQuery = { accessKey, status: 'authorized', nfseXml, dhProc: parsed.dhProc }
    // L6 do gate da Rodada 13: o bloco embutido é por construção um <e101101> (cancelBlock) — o código vai junto (D-F71)
    if (parsed.cancelled) return { ...base, status: 'cancelled', cancelled: { dhEvento: parsed.cancelled.dhEvento, motive: parsed.cancelled.xMotivo, eventCode: EVENT_CANCEL } }

    // cStat (100/102/103/107) NÃO expressa cancelamento: a situação vem dos EVENTOS da chave.
    // D-F61 (= Q-F68 (a), Valdo 2026-10-10): pelo contrato REAL da Sefin (cravado ao vivo em H — `GET /nfse/{chave}/eventos`
    // dava 405 e TODA consulta de autorizada falhava): um código de cancelamento por vez, por tipo + sequência.
    // CONHECIMENTO NEGATIVO (D-F86 = Q-F92 (a), Valdo 2026-10-11): o laço PARA no primeiro tipo achado e NÃO pergunta as rotas
    // restantes — premissa da D-F61: o fisco registra UM cancelamento por NFS-e (cancelada não se cancela de novo). Contradição
    // ENTRE rotas não é procurada de propósito (até 3 GETs a mais por nota cancelada, contra uma impossibilidade fiscal); reabrir
    // só se a prova ao vivo do C por consulta (M4) mostrar dois cancelamentos para a mesma chave. Contradição DENTRO de uma rota
    // é ambígua (D-F84/D-F88/D-F89). Teste que fixa: "D-F86" no adversarial-r11-gate.
    for (const code of CANCEL_EVENT_CODES) {
      const xmls = await cancelEventXmls(ctx, key, code)
      if (xmls === null) continue                                   // a Sefin disse: não há esse evento
      if (!xmls.length) return { ...base, status: 'unknown', unknownCause: 'evento-ilegivel' }       // listou e nada se lê: ilegível nunca vira "autorizada"
      // R2-2 (d): só evento GERADO (Id EVT + dhProc) e DESTA chave cancela — evento de outra NFS-e (resposta trocada) ou
      // pedido ecoado (sem Id/dhProc) não é voz sobre esta
      // D-F88 (= Q-F94, Valdo 2026-10-11): conta TODO evento GERADO desta chave, de qualquer tipo — um tipo fora do domínio de
      // cancelamento (e105105 indeferido, e101103…) no GET tipado também é contradição (o GET por tipo + sequência só devolve o tipo)
      // R18-07 do gate da Rodada 18: evento que o leitor não consegue ler (entidade inválida em qualquer campo, inclusive os da
      // assinatura da D-F93) é resposta ILEGÍVEL → ambíguo (502), nunca exceção crua (500 na tela; no rodízio, nem alarme nem carimbo)
      let read: { generated: { xml: string; ev: ReturnType<typeof parseEventXml> }[]; signatures: Set<string> }
      try {
        const g = xmls.map(x => ({ xml: x, ev: parseEventXml(x) })).filter(({ ev: e }) => !!e.eventCode && isGeneratedEventFor(e, accessKey))
        read = { generated: g, signatures: new Set(g.filter(({ ev: e }) => CANCEL_EVENT_CODES.has(e.eventCode!)).map(({ ev: e, xml }) => eventSignature(e, xml))) }
      } catch {
        logger.error('Contrato da Sefin divergente: evento ilegível no GET tipado', { code, environment: ctx.environment, items: xmls.length })
        return { ...base, status: 'unknown', unknownCause: 'evento-ilegivel' }
      }
      const generated = read.generated
      const candidates = generated.filter(({ ev: e }) => CANCEL_EVENT_CODES.has(e.eventCode!))
      // D-F84 (= Q-F90, Valdo 2026-10-10 — supera a escolha do L7): o GET tipado que traz TIPOS DIFERENTES desta chave é resposta
      // contraditória → AMBÍGUO (502): nenhuma marca, nenhum efeito (como a D-F63) — nem o tipo perguntado (a marca menos restritiva)
      // nem a substituição (abriria o "manter a nota" sobre uma resposta que se contradiz)
      if (new Set(generated.map(({ ev: e }) => e.eventCode)).size > 1) {
        logger.error('Contrato da Sefin divergente: tipos diferentes de evento no mesmo GET tipado', { code, codes: generated.map(({ ev: e }) => e.eventCode), environment: ctx.environment })
        return { ...base, status: 'unknown', unknownCause: 'evento-contraditorio' }
      }
      // D-F89 (= Q-F95, Valdo 2026-10-11): o MESMO tipo repetido só vale com o MESMO conteúdo — outra substituta, outro motivo, outro
      // instante ou outro Id no mesmo GET tipado também é contradição (o que se exibe/aplica não pode depender da ordem da lista)
      if (read.signatures.size > 1) {
        logger.error('Contrato da Sefin divergente: eventos do mesmo tipo com conteúdo diferente no mesmo GET tipado', { code, items: candidates.length, environment: ctx.environment })
        return { ...base, status: 'unknown', unknownCause: 'evento-contraditorio' }
      }
      // D-F96 (= Q-F102 (c)): repetição (assinaturas iguais) — o XML arquivado é escolhido de forma DETERMINÍSTICA (o menor na ordem
      // do texto), nunca pela ordem da lista do fisco
      const found = [...candidates].sort((a, b) => (a.xml < b.xml ? -1 : a.xml > b.xml ? 1 : 0))[0]
      // D-F63 (= Q-F70, Valdo 2026-10-10): no GET TIPADO (chave + tipo + sequência) um 200 diz "esse evento EXISTE" — o que
      // não se confere como cancelamento gerado desta chave (ilegível, outra chave, eco, outro tipo) é resposta trocada/ilegível:
      // ambíguo, NUNCA "autorizada" (antes gravava N falso num K em voo — gates DF61-01/02, M3). A R2-2 (d) "segue autorizada"
      // era da LISTA `GET /eventos`, que a Sefin não tem
      if (!found) {
        logger.error('Contrato da Sefin divergente: 200 de evento que não se confere como cancelamento desta chave', { code, environment: ctx.environment, items: xmls.length })
        return { ...base, status: 'unknown', unknownCause: 'evento-nao-conferido' }
      }
      // D-F69 (= Q-F76 (a), Valdo 2026-10-10): tipo PERGUNTADO × código do XML divergentes = resposta contraditória → ambíguo,
      // SALVO quando o XML diz SUBSTITUIÇÃO (fica a marca mais restritiva — D-F64: sem efeito local automático)
      if (found.ev.eventCode !== code && found.ev.eventCode !== '105102') {
        logger.error('Contrato da Sefin divergente: evento de tipo diferente do perguntado', { code, eventCode: found.ev.eventCode, environment: ctx.environment })
        return { ...base, status: 'unknown', unknownCause: 'evento-contraditorio' }
      }
      const cancel = found.ev
      return { ...base, status: 'cancelled', cancelled: { dhEvento: cancel.dhProc ?? cancel.dhEvento, motive: cancel.xMotivo, eventXml: found.xml, eventCode: cancel.eventCode } }
    }
    return base
  },

  async queryDpsAccessKey(ctx, dpsId): Promise<string | null> {
    try {
      const { status, data, text } = await call<any>(ctx, 'GET', `/dps/${encodeURIComponent(dpsId)}`, undefined, 'dps')
      const key = asAccessKey(data?.chaveAcesso) ?? asAccessKey(data?.chave) ?? (text.match(/\b\d{50}\b/)?.[0] ?? null)
      if (!key) throw unknownResponse('dps-fora-do-contrato', 'dps', status, text)
      // R19-03 do gate da Rodada 19: a chave tem de ser do EMITENTE do Id perguntado — chave 50 = cMun(7) + ambGer(1) + tpInsc(1) +
      // inscrição(14) + …; Id do DPS = "DPS" + cMun(7) + tpInsc(1) + inscrição(14) + … (mesma regra do `sameIssuerKey` da D-F85;
      // conferido nas 3 chaves reais de produção em 2026-10-11). Chave de OUTRO emitente (resposta trocada) nunca vira URL nem voz.
      if (key.slice(8, 23) !== String(dpsId).slice(10, 25)) throw unknownResponse('dps-fora-do-contrato', 'dps: chave de OUTRO emitente', status, text)
      return key
    } catch (err) {
      // Q-ADV1a (Valdo 2026-09-30): 404 só é "DPS sem NFS-e" (conclusivo → F) quando é a RESPOSTA do fisco
      // (corpo JSON estruturado); 404 vazio/HTML (gateway, proxy, rota) é ilegível → 502, a tentativa fica em voo
      if (err instanceof AuthorityHttpError && err.authorityStatus === 404) {
        if (isDpsNotGenerated(err.body, ctx.environment)) return null
        throw unknownResponse('dps-fora-do-contrato', 'dps: 404 sem resposta estruturada do fisco', 404, err.body)
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
    // gate R19 (S5): evento que o leitor não lê → ambíguo (502), nunca exceção crua
    let ev: ReturnType<typeof parseEventXml> | null
    try { ev = xml ? parseEventXml(xml) : null } catch { throw unknownResponse('evento-ilegivel', 'evento: resposta ilegível', status, text) }
    if (!ev || ev.eventCode !== EVENT_CANCEL || !isGeneratedEventFor(ev, accessKey)) {
      throw unknownResponse('evento-sem-retorno', 'evento: resposta sem o evento gerado para esta chave', status, text)
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
