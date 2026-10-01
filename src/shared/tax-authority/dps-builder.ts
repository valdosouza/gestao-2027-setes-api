import { toUtcDb, nowIsoIn, DEFAULT_TIME_ZONE } from '@shared/time-zone'
import {
  AuthorityEnvironment, CancelEventInput, DpsInput, DpsTpInsc, ParsedEvent, ParsedNfse,
} from './types'

/**
 * Montagem do XML do DPS v1.01 e do pedido de registro de evento (cancelamento
 * e101101), FIEL ao XSD (Infra-IA/setes-api/integracoes/nfse-adn/xsd/Schemas/1.01):
 * ordem dos elementos = ordem do `xs:sequence`; opcional só entra se veio;
 * decimais com 2 casas e ponto; strings escapadas; sem espaço/quebra entre
 * tags (Manual 2022 §6.1 d: "não incluir caracteres de formatação").
 * Sem lib de XML: o leiaute é fixo e pequeno — um escapador basta.
 */

export const NFSE_NS      = 'http://www.sped.fazenda.gov.br/nfse'
export const LAYOUT_VERSION = '1.01'
export const EVENT_CANCEL = '101101'
/**
 * R3-3: tiposEventos_v1.01.xsd tem QUATRO cancelamentos — e101101 (contribuinte) · e105102 (por
 * substituição) · e105104 (deferido por análise fiscal — o único caminho fora do prazo municipal) ·
 * e305101 (de ofício, pelo fisco). Todos chegam por GET /eventos como evento gerado desta chave.
 */
export const CANCEL_EVENT_CODES: ReadonlySet<string> = new Set(['101101', '105102', '105104', '305101'])
/** Faixa de série do aplicativo próprio (Manual: 50000–99999 são do emissor nacional). Fonte ÚNICA — DTO e Id consomem daqui. */
export const DPS_SERIE_MIN = 1
export const DPS_SERIE_MAX = 49_999
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'

// ---------------------------------------------------------------------------
// utilitários de formatação
// ---------------------------------------------------------------------------

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string))
}

export function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (_, e: string) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'
    if (e === 'quot') return '"'; if (e === 'apos') return "'"
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  })
}

/** TSDec*V2: 2 casas, ponto, sem separador de milhar ("0" e "0.50" válidos). */
export function dec2(v: number): string {
  if (!Number.isFinite(v) || v < 0) throw new Error(`Valor decimal inválido para o DPS: ${v}`)
  return v.toFixed(2)
}

/** TSString: sem espaço nas pontas e sem controle; multiline mantém \n (TSStringComQuebraDeLinha). */
function text(s: string, multiline = false): string {
  const t = String(s ?? '').replace(/\r\n?/g, '\n')
  const cleaned = multiline ? t.replace(/[^\S\n]+\n/g, '\n') : t.replace(/[\n\t]+/g, ' ')
  return cleaned.trim()
}

function digits(s: string | number, label: string, len?: number): string {
  const d = String(s ?? '').replace(/\D/g, '')
  if (!d || (len !== undefined && d.length !== len)) throw new Error(`${label} inválido (esperado ${len ?? '≥1'} dígitos): ${s}`)
  return d
}

/**
 * TSDateTimeUTC: AAAA-MM-DDThh:mm:ss±hh:00 (sem milissegundos; 'Z' vira +00:00).
 * Aceita ISO com fuso; sem fuso = hora OFICIAL de Brasília (nunca o fuso do processo — Q-TZ1).
 */
export function formatDateTimeTz(iso: string): string {
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  if (m) return `${m[1]}T${m[2]}${m[3] === 'Z' ? '+00:00' : m[3]}`
  // L2 do gate socrático (onda TZ-1): sem offset = hora OFICIAL de Brasília — nunca o
  // fuso do processo Node (servidor em UTC mandaria -00:00 ao fisco)
  const utc = toUtcDb(iso, DEFAULT_TIME_ZONE)
  if (!utc) throw new Error(`Data/hora inválida para o DPS: ${iso}`)
  return nowIsoIn(DEFAULT_TIME_ZONE, new Date(`${utc.replace(' ', 'T')}Z`))
}

/** tpAmb do XSD: 1 produção · 2 homologação (produção restrita). */
export function tpAmbOf(environment: AuthorityEnvironment): '1' | '2' {
  return environment === 'P' ? '1' : '2'
}

const el = (name: string, value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '' : `<${name}>${escapeXml(value)}</${name}>`
const grp = (name: string, inner: string, attrs = ''): string => `<${name}${attrs}>${inner}</${name}>`

// ---------------------------------------------------------------------------
// Id do DPS (45) e XML do DPS
// ---------------------------------------------------------------------------

/**
 * "DPS" + cMun(7) + tpInsc(1: 1 CPF · 2 CNPJ) + inscrição(14, zero à esquerda)
 * + série(5) + nDPS(15) = 45 posições (TSIdDPS `DPS[0-9]{42}`).
 */
export function buildDpsId(cMun: string, tpInsc: DpsTpInsc, inscricao: string, serie: number | string, nDps: number | string): string {
  const mun = digits(cMun, 'cMun', 7)
  if (tpInsc !== '1' && tpInsc !== '2') throw new Error(`tpInsc inválido: ${tpInsc}`)
  const insc = digits(inscricao, 'inscrição')
  if (insc.length > 14) throw new Error(`inscrição com mais de 14 dígitos: ${inscricao}`)
  const s = Number(serie), n = Number(nDps)
  // séries do aplicativo próprio = 00001–49999 (50000+ são do emissor nacional — §1 do prompt);
  // defesa em profundidade: a linha do emissor pode ter vindo por SQL (ACHADO 3 do gate)
  if (!Number.isInteger(s) || s < DPS_SERIE_MIN || s > DPS_SERIE_MAX) throw new Error(`série inválida (esperado ${DPS_SERIE_MIN}–${DPS_SERIE_MAX}): ${serie}`)
  if (!Number.isInteger(n) || n < 1 || n > 999999999999999) throw new Error(`nDPS inválido: ${nDps}`)
  const id = `DPS${mun}${tpInsc}${insc.padStart(14, '0')}${String(s).padStart(5, '0')}${String(n).padStart(15, '0')}`
  if (id.length !== 45) throw new Error(`Id do DPS com ${id.length} posições (esperado 45)`)
  return id
}

function prestXml(p: DpsInput['prest']): string {
  const inner =
    el('CNPJ', digits(p.cnpj, 'CNPJ do prestador', 14)) +
    el('IM', p.im ? text(p.im) : null) +
    grp('regTrib', el('opSimpNac', p.regTrib.opSimpNac) + el('regApTribSN', p.regTrib.regApTribSN) + el('regEspTrib', p.regTrib.regEspTrib))
  return grp('prest', inner)
}

function tomaXml(t: NonNullable<DpsInput['toma']>): string {
  if (!!t.cnpj === !!t.cpf) throw new Error('Tomador exige CNPJ ou CPF (exatamente um)')
  let inner = t.cnpj ? el('CNPJ', digits(t.cnpj, 'CNPJ do tomador', 14)) : el('CPF', digits(t.cpf!, 'CPF do tomador', 11))
  inner += el('IM', t.im ? text(t.im) : null) + el('xNome', text(t.xNome))
  if (t.end) {
    inner += grp('end',
      grp('endNac', el('cMun', digits(t.end.cMun, 'cMun do tomador', 7)) + el('CEP', digits(t.end.cep, 'CEP do tomador', 8))) +
      el('xLgr', text(t.end.xLgr)) + el('nro', text(t.end.nro)) + el('xCpl', t.end.xCpl ? text(t.end.xCpl) : null) + el('xBairro', text(t.end.xBairro)))
  }
  inner += el('fone', t.fone ? digits(t.fone, 'fone do tomador') : null) + el('email', t.email ? text(t.email) : null)
  return grp('toma', inner)
}

function servXml(s: DpsInput['serv']): string {
  let inner = grp('locPrest', el('cLocPrestacao', digits(s.locPrest.cLocPrestacao, 'cLocPrestacao', 7)))
  inner += grp('cServ',
    el('cTribNac', digits(s.cServ.cTribNac, 'cTribNac', 6)) +
    el('cTribMun', s.cServ.cTribMun ? digits(s.cServ.cTribMun, 'cTribMun', 3) : null) +
    el('xDescServ', text(s.cServ.xDescServ, true).slice(0, 2000)) +
    el('cNBS', s.cServ.cNBS ? digits(s.cServ.cNBS, 'cNBS', 9) : null))
  if (s.infoCompl && (s.infoCompl.docRef || s.infoCompl.xPed || s.infoCompl.xInfComp)) {
    inner += grp('infoCompl',
      el('docRef', s.infoCompl.docRef ? text(s.infoCompl.docRef).slice(0, 255) : null) +
      el('xPed', s.infoCompl.xPed ? text(s.infoCompl.xPed).slice(0, 60) : null) +
      el('xInfComp', s.infoCompl.xInfComp ? text(s.infoCompl.xInfComp).slice(0, 2000) : null))
  }
  return grp('serv', inner)
}

function valoresXml(v: DpsInput['valores']): string {
  let inner = grp('vServPrest', el('vServ', dec2(v.vServ)))
  if (v.vDescIncond !== undefined || v.vDescCond !== undefined) {
    inner += grp('vDescCondIncond',
      el('vDescIncond', v.vDescIncond !== undefined ? dec2(v.vDescIncond) : null) +
      el('vDescCond', v.vDescCond !== undefined ? dec2(v.vDescCond) : null))
  }
  const tm = v.trib.tribMun
  if (tm.pAliq !== undefined && (tm.pAliq < 0 || tm.pAliq >= 10)) throw new Error(`pAliq fora de TSDec1V2 (0–9.99): ${tm.pAliq}`)
  const tribMun = grp('tribMun', el('tribISSQN', tm.tribISSQN) + el('tpRetISSQN', tm.tpRetISSQN) + el('pAliq', tm.pAliq !== undefined ? dec2(tm.pAliq) : null))
  const tt = v.trib.totTrib
  const totTrib = grp('totTrib', 'indTotTrib' in tt ? el('indTotTrib', tt.indTotTrib) : el('pTotTribSN', dec2(tt.pTotTribSN)))
  inner += grp('trib', tribMun + totTrib)
  return grp('valores', inner)
}

/**
 * XML do DPS pronto para assinar: `<DPS xmlns versao="1.01"><infDPS Id="…">…</infDPS></DPS>`,
 * com a declaração `<?xml …?>` (Manual 2022 §6.1 a). Sem Signature — quem assina é `signXml`.
 */
export function buildDpsXml(input: DpsInput, id: string): string {
  if (!/^DPS\d{42}$/.test(id)) throw new Error(`Id do DPS inválido: ${id}`)
  if (input.tpEmit !== '1') throw new Error('tpEmit: só o prestador emite nesta onda (E9996)')
  const serie = Number(input.serie), nDps = Number(input.nDps)
  if (!Number.isInteger(serie) || serie < 1 || !Number.isInteger(nDps) || nDps < 1) throw new Error('serie/nDPS inválidos')
  const inf =
    el('tpAmb', tpAmbOf(input.environment)) +
    el('dhEmi', formatDateTimeTz(input.dhEmi)) +
    el('verAplic', text(input.verAplic).slice(0, 20)) +
    // [INCERTO] série SEM zero à esquerda no elemento (o Id leva 5 posições); TSSerieDPS aceita ambos
    el('serie', String(serie)) +
    el('nDPS', String(nDps)) +
    el('dCompet', /^\d{4}-\d{2}-\d{2}$/.test(input.dCompet) ? input.dCompet : (() => { throw new Error(`dCompet inválida: ${input.dCompet}`) })()) +
    el('tpEmit', input.tpEmit) +
    el('cLocEmi', digits(input.cLocEmi, 'cLocEmi', 7)) +
    prestXml(input.prest) +
    (input.toma ? tomaXml(input.toma) : '') +
    servXml(input.serv) +
    valoresXml(input.valores)
  return XML_DECLARATION + grp('DPS', grp('infDPS', inf, ` Id="${id}"`), ` xmlns="${NFSE_NS}" versao="${LAYOUT_VERSION}"`)
}

// ---------------------------------------------------------------------------
// Pedido de registro de evento — cancelamento e101101
// ---------------------------------------------------------------------------

/** "PRE" + chave(50) + código do evento(6) = 59 (TSIdPedRegEvt `PRE[0-9]{56}`; Anexo II linha 13). */
export function buildEventId(accessKey: string, eventCode: string): string {
  return `PRE${digits(accessKey, 'chave de acesso', 50)}${digits(eventCode, 'código do evento', 6)}`
}

/**
 * `<pedRegEvento xmlns versao="1.01"><infPedReg Id="PRE…">tpAmb, verAplic, dhEvento,
 * CNPJAutor|CPFAutor, chNFSe, e101101{xDesc fixo, cMotivo, xMotivo}</infPedReg></pedRegEvento>`.
 * O XSD não tem número/sequencial do pedido: o sequencial só existe no Id `EVT…` que o fisco cunha.
 */
export function buildCancelEventXml(input: CancelEventInput): string {
  if (!!input.cnpjAutor === !!input.cpfAutor) throw new Error('Autor do evento exige CNPJ ou CPF (exatamente um)')
  const motive = text(input.xMotivo, false)
  if (motive.length < 15 || motive.length > 255) throw new Error('xMotivo do cancelamento deve ter 15 a 255 caracteres')
  if (!['1', '2', '9'].includes(input.cMotivo)) throw new Error(`cMotivo inválido: ${input.cMotivo}`)
  const chave = digits(input.accessKey, 'chave de acesso', 50)
  const inf =
    el('tpAmb', tpAmbOf(input.environment)) +
    el('verAplic', text(input.verAplic).slice(0, 20)) +
    el('dhEvento', formatDateTimeTz(input.dhEvento)) +
    (input.cnpjAutor ? el('CNPJAutor', digits(input.cnpjAutor, 'CNPJ do autor', 14)) : el('CPFAutor', digits(input.cpfAutor!, 'CPF do autor', 11))) +
    el('chNFSe', chave) +
    grp(`e${EVENT_CANCEL}`, el('xDesc', 'Cancelamento de NFS-e') + el('cMotivo', input.cMotivo) + el('xMotivo', motive))
  return XML_DECLARATION + grp('pedRegEvento', grp('infPedReg', inf, ` Id="${buildEventId(chave, EVENT_CANCEL)}"`), ` xmlns="${NFSE_NS}" versao="${LAYOUT_VERSION}"`)
}

// ---------------------------------------------------------------------------
// Leitura dos XML do fisco (sem prefixo de namespace — vedado pelo manual)
// ---------------------------------------------------------------------------

function firstText(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? unescapeXml(m[1].trim()) : null
}
function attrOf(xml: string, element: string, attr: string): string | null {
  const m = xml.match(new RegExp(`<${element}\\b[^>]*\\s${attr}="([^"]*)"`))
  return m ? m[1] : null
}

/** Bloco de cancelamento (e101101) se existir no texto. */
function cancelBlock(xml: string): { dhEvento: string | null; cMotivo: string | null; xMotivo: string | null } | null {
  const m = xml.match(/<e101101>[\s\S]*?<\/e101101>/)
  if (!m) return null
  return { dhEvento: firstText(xml, 'dhEvento'), cMotivo: firstText(m[0], 'cMotivo'), xMotivo: firstText(m[0], 'xMotivo') }
}

/** NFS-e autorizada: chave (infNFSe/@Id sem "NFS"), número, dhProc, cStat, id do DPS embutido. */
export function parseNfseXml(xml: string): ParsedNfse {
  const rawId = attrOf(xml, 'infNFSe', 'Id')
  const accessKey = rawId ? rawId.replace(/^NFS/, '') : null
  const infNfse = xml.match(/<infNFSe\b[\s\S]*?<emit>/)?.[0] ?? xml     // cabeçalho antes do emit (evita pegar dados do DPS embutido)
  return {
    accessKey,
    nNFSe:  firstText(infNfse, 'nNFSe'),
    dhProc: firstText(infNfse, 'dhProc'),
    cStat:  firstText(infNfse, 'cStat'),
    nDFSe:  firstText(infNfse, 'nDFSe'),
    ambGer: firstText(infNfse, 'ambGer'),
    dpsId:  attrOf(xml, 'infDPS', 'Id'),
    cancelled: cancelBlock(xml),
  }
}

/** Evento (gerado pelo fisco) ou pedido de registro: ids, código, chave, datas e motivo. */
export function parseEventXml(xml: string): ParsedEvent {
  const codeMatch = xml.match(/<e(\d{6})>/)
  const cancel = cancelBlock(xml)
  const specific = codeMatch ? xml.match(new RegExp(`<e${codeMatch[1]}>[\\s\\S]*?</e${codeMatch[1]}>`))?.[0] ?? '' : ''
  return {
    eventId:    attrOf(xml, 'infEvento', 'Id'),
    pedRegId:   attrOf(xml, 'infPedReg', 'Id'),
    eventCode:  codeMatch ? codeMatch[1] : null,
    accessKey:  firstText(xml, 'chNFSe'),
    dhEvento:   firstText(xml, 'dhEvento'),
    dhProc:     firstText(xml, 'dhProc'),
    nSeqEvento: firstText(xml, 'nSeqEvento'),
    cMotivo:    cancel?.cMotivo ?? (specific ? firstText(specific, 'cMotivo') : null),
    xMotivo:    cancel?.xMotivo ?? (specific ? firstText(specific, 'xMotivo') : null),
  }
}
