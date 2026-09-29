import fs from 'fs'
import path from 'path'
import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError, FieldError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { getEntityFiscalFull } from '@shared/entity'
import { getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { LAST_INVOICE_EVENT_KIND_SQL } from '@shared/invoice/invoice'
import { openIssuer, OpenedIssuer, IssuerEnvironment } from '@shared/fiscal-issuer'
import {
  AuthorityContext, AuthorityHttpError, DpsInput, DpsToma, TaxAuthorityAdapter, MunicipalTerms,
  adapterFor, buildDpsId, buildDpsXml, buildCancelEventXml, buildEventId, signXml, ADN_SIGN_ALGORITHM, isLocalCredentialError,
} from '@shared/tax-authority'
import { TransmissionEventKind } from '../transmission.repository'

/**
 * ESTRATÉGIA DO RAMO DE SERVIÇO (D-E6 / §3.11 da NF-e: UMA composição, o ramo
 * só troca o DOCUMENTO — nunca a política). Aqui vive o que é do DPS:
 *   - leitura do ramo (`tb_invoice_service`) + cabeçalho da nota;
 *   - cadeia do emitente (institution) e do tomador + `tb_entity_tax` do
 *     emitente → `DpsInput` (lidos na transmissão, congelados só no XML assinado
 *     — o arquivo é o snapshot, §3 "O ramo de serviço como base do DPS");
 *   - assinatura (XMLDSig, algoritmo do ADN), adaptador ADN, contexto mTLS pelo
 *     AMBIENTE CONGELADO da tentativa (D-N6: o A1 é do ambiente);
 *   - mapa "voz do fisco → kind" e prazo de cancelamento do PAM (D-N15, cache 1 h);
 *   - XML do DPS assinado e da NFS-e autorizada em disco (nunca em coluna).
 * `branches/merchandise.ts` nasce quando a NF-e executar (D-E20 a) com a mesma
 * interface — a orquestração em `../invoice-transmission.ts` não muda.
 */

export const SERVICE_MODEL = 'SE' as const
/** verAplic do DPS (1–20 chars). */
export const VER_APLIC = 'SETES-1.0'
/** Motivo padrão do evento e101101: cMotivo 1 = erro na emissão. */
export const CANCEL_MOTIVE_CODE = '1' as const
const XMOTIVO_MIN = 15
const XMOTIVO_MAX = 255

// ---------------------------------------------------------------------------
// Leitura do ramo
// ---------------------------------------------------------------------------

export interface ServiceBranchRow {
  serviceListId: string | null
  nationalCode:  string | null
  municipalCode: string | null
  cityId:        number | null
  baseIss:       number
  aliqIss:       number
  issValue:      number
  issWithheld:   'S' | 'N'
  liability:     '1' | '2' | '3' | '4'
  dpsNumber:     number | null
  description:   string | null
  totalValue:    number
}

export interface ServiceInvoiceHeader {
  invoiceId:   number
  number:      string | null
  serie:       string | null
  model:       string | null
  value:       number
  dtEmission:  string          // YYYY-MM-DD
  entityId:    number          // tomador
  status:      string
  /** Último evento da NOTA (E/C); null = sincronizada (sem história na web). */
  lastInvoiceKind: string | null
  /** Nº do último evento da nota — conferido de novo SOB o lock da reserva (MEDIUM-3). */
  lastInvoiceEvent: number | null
  /** updated_at do ramo lido FORA da transação — conferido FOR UPDATE dentro (MEDIUM-3). */
  branchUpdatedAt: string | null
  branch:      ServiceBranchRow
}

/**
 * Nota emitida POR ESTE estabelecimento (issuer = institution), viva, com o ramo
 * de serviço. Sem ramo → 422 INVOICE_SERVICE_BRANCH_MISSING; sem código nacional
 * na regra congelada → 422 SERVICE_RULE_NATIONAL_CODE_REQUIRED (D-N11a).
 */
export async function readServiceInvoice(
  q: PoolConnection | typeof pool, schemaName: string, institutionId: number, invoiceId: number
): Promise<ServiceInvoiceHeader> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT i.id, i.number, i.serie, i.model, i.value, DATE_FORMAT(i.dt_emission, '%Y-%m-%d') AS dtEmission,
            i.tb_entity_id AS entityId, i.status, ${LAST_INVOICE_EVENT_KIND_SQL(s, 'i')} AS lastKind,
            (SELECT ev.event FROM \`${s}\`.tb_invoice_event ev
              WHERE ev.tb_institution_id = i.tb_institution_id AND ev.tb_invoice_id = i.id AND ev.terminal = i.terminal
                AND ev.deleted = 'N' ORDER BY ev.event DESC LIMIT 1) AS lastEvent,
            DATE_FORMAT(sv.updated_at, '%Y-%m-%d %H:%i:%s') AS branchUpdatedAt,
            sv.id AS branchId, sv.tb_service_list_id AS serviceListId, sv.national_code AS nationalCode,
            sv.municipal_code AS municipalCode, sv.tb_city_id AS cityId, sv.base_iss_value AS baseIss,
            sv.aliq_iss AS aliqIss, sv.iss_value AS issValue, sv.iss_withheld AS issWithheld, sv.liability,
            sv.dps_number AS dpsNumber, CONVERT(sv.description USING utf8mb4) AS description, sv.total_value AS totalValue
       FROM \`${s}\`.tb_invoice i
       LEFT JOIN \`${s}\`.tb_invoice_service sv
         ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
      WHERE i.id = ? AND i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND i.issuer = i.tb_institution_id`,
    [invoiceId, institutionId]
  )
  const r = rows[0]
  if (!r) throw new HttpError(404, `Nota ${invoiceId} emitida por este estabelecimento não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  if (r.branchId == null) {
    throw new HttpError(422, `Nota ${invoiceId} não tem ramo de serviço — só nota com serviço gera DPS`,
      [{ field: 'service', message: 'Ramo de serviço ausente' }], ErrorCodes.INVOICE_SERVICE_BRANCH_MISSING)
  }
  return {
    invoiceId: Number(r.id), number: r.number ?? null, serie: r.serie ?? null, model: r.model ?? null,
    value: Number(r.value ?? 0), dtEmission: String(r.dtEmission), entityId: Number(r.entityId),
    status: String(r.status ?? ''), lastInvoiceKind: r.lastKind ?? null,
    lastInvoiceEvent: r.lastEvent == null ? null : Number(r.lastEvent), branchUpdatedAt: r.branchUpdatedAt ?? null,
    branch: {
      serviceListId: r.serviceListId ?? null, nationalCode: r.nationalCode ?? null, municipalCode: r.municipalCode ?? null,
      cityId: r.cityId == null ? null : Number(r.cityId), baseIss: Number(r.baseIss ?? 0), aliqIss: Number(r.aliqIss ?? 0),
      issValue: Number(r.issValue ?? 0), issWithheld: r.issWithheld === 'S' ? 'S' : 'N',
      liability: (['1', '2', '3', '4'].includes(String(r.liability)) ? String(r.liability) : '1') as ServiceBranchRow['liability'],
      dpsNumber: r.dpsNumber == null ? null : Number(r.dpsNumber), description: r.description ?? null,
      totalValue: Number(r.totalValue ?? 0),
    },
  }
}

/** nDPS + updated_at do ramo SOB LOCK (a leitura fora da transação pode estar velha — D-N3 write-once / MEDIUM-3). */
export async function lockDpsNumber(
  conn: PoolConnection, schemaName: string, institutionId: number, invoiceId: number
): Promise<{ dpsNumber: number | null; updatedAt: string | null }> {
  const s = assertSchema(schemaName)
  const [rows] = await conn.query<any[]>(
    `SELECT dps_number AS dpsNumber, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updatedAt FROM \`${s}\`.tb_invoice_service
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' FOR UPDATE`,
    [invoiceId, institutionId]
  )
  if (!rows[0]) {
    throw new HttpError(422, `Nota ${invoiceId} não tem ramo de serviço`, undefined, ErrorCodes.INVOICE_SERVICE_BRANCH_MISSING)
  }
  return { dpsNumber: rows[0].dpsNumber == null ? null : Number(rows[0].dpsNumber), updatedAt: rows[0].updatedAt ?? null }
}

// ---------------------------------------------------------------------------
// Emitente / tomador → DpsInput
// ---------------------------------------------------------------------------

const digitsOf = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '')

async function cityIbge(cityId: number | null | undefined): Promise<string | null> {
  if (cityId == null) return null
  const [rows] = await pool.query<any[]>(`SELECT ibge FROM setes_central.tb_city WHERE id = ?`, [cityId])
  const ibge = digitsOf(rows[0]?.ibge)
  return ibge.length === 7 ? ibge : null
}

export interface EmitterIdentity {
  cnpj:    string
  im:      string | null
  name:    string
  cMunEmi: string
}

/**
 * O emitente É a institution (cadeia + `tb_entity_tax` da própria — D-E3/D-E23).
 * O que falta se corrige no cadastro, não no DPS (D-I17 espelhada): 422 com o campo.
 */
export async function buildEmitter(schemaName: string, institutionId: number): Promise<{ identity: EmitterIdentity; prest: DpsInput['prest'] }> {
  const full = await getEntityFiscalFull(institutionId)
  const missing: FieldError[] = []
  const cnpj = digitsOf(full?.company?.cnpj)
  if (!full || cnpj.length !== 14) missing.push({ field: 'emitter.cnpj', message: 'Estabelecimento sem CNPJ (pessoa jurídica)' })
  const addr = full?.addresses.find(a => a.main === 'S') ?? full?.addresses[0]
  const cMun = await cityIbge(addr?.tbCityId)
  if (!addr) missing.push({ field: 'emitter.address', message: 'Estabelecimento sem endereço principal' })
  else if (!cMun) missing.push({ field: 'emitter.city', message: 'Cidade do endereço principal sem código IBGE (7 dígitos)' })
  if (missing.length) {
    throw new HttpError(422, 'Cadastro do estabelecimento incompleto para o DPS — complete no Meu Estabelecimento',
      missing, ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  const tax = await getEntityTax(schemaName, institutionId, institutionId)
  // D-N19 (MEDIUM-5): opSimpNac é FATO do emitente — sem default silencioso (um
  // "1 não optante" chutado para um MEI muda o imposto). Ausente → 422 com o campo.
  if (!['1', '2', '3'].includes(String(tax?.simplesRegime))) {
    throw new HttpError(422, 'Estabelecimento sem o regime do Simples (opSimpNac) na aba Tributação — informe: 1 não optante · 2 MEI · 3 ME/EPP',
      [{ field: 'simplesRegime', message: 'Obrigatório para o DPS (D-N19)' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  const opSimpNac = String(tax!.simplesRegime) as '1' | '2' | '3'
  // D-N19a (Valdo: a Setes é ME/EPP): regApTribSN só para opSimpNac 3 e só quando o emitente ultrapassou
  // sublimite/limite (fato informado na aba Tributação); NULL = elemento OMITIDO (opcional no XSD — o
  // fisco apura pelo SN). Não é default silencioso: é a ausência do fato, e o XSD a prevê.
  const regApTribSN = opSimpNac === '3' && ['1', '2', '3'].includes(String(tax?.simplesAssessment))
    ? (String(tax!.simplesAssessment) as '1' | '2' | '3') : undefined
  // regEspTrib: NULL → '0' (nenhum regime especial) é o caso comum e o default do XSD faz sentido — documentado, não silencioso
  const regEspTrib = (['0', '1', '2', '3', '4', '5', '6'].includes(String(tax?.specialTaxRegime)) ? String(tax!.specialTaxRegime) : '0') as DpsInput['prest']['regTrib']['regEspTrib']
  const im = (full!.company!.im ?? '').trim() || null
  return {
    identity: { cnpj, im, name: (full!.entity.nameCompany ?? full!.entity.nickTrade ?? '').trim(), cMunEmi: cMun! },
    prest: { cnpj, ...(im ? { im } : {}), regTrib: { opSimpNac, ...(regApTribSN ? { regApTribSN } : {}), regEspTrib } },
  }
}

/** Tomador: CNPJ ou CPF + nome; endereço só quando COMPLETO (o XSD o deixa opcional). */
export async function buildRecipient(entityId: number): Promise<DpsToma> {
  const full = await getEntityFiscalFull(entityId)
  const missing: FieldError[] = []
  const cnpj = digitsOf(full?.company?.cnpj)
  const cpf = digitsOf(full?.person?.cpf)
  if (!full || (cnpj.length !== 14 && cpf.length !== 11)) missing.push({ field: 'recipient.document', message: 'Tomador sem CPF/CNPJ válido' })
  const xNome = (full?.entity.nameCompany ?? full?.entity.nickTrade ?? '').trim()
  if (!xNome) missing.push({ field: 'recipient.name', message: 'Tomador sem nome' })
  if (missing.length) {
    throw new HttpError(422, `Cadastro do tomador ${entityId} incompleto para o DPS — complete o cadastro da entidade`,
      missing, ErrorCodes.FISCAL_RECIPIENT_INCOMPLETE)
  }
  const toma: DpsToma = cnpj.length === 14 ? { cnpj, xNome } : { cpf, xNome }
  const im = (full!.company?.im ?? '').trim()
  if (im) toma.im = im
  const addr = full!.addresses.find(a => a.main === 'S') ?? full!.addresses[0]
  if (addr) {
    const cMun = await cityIbge(addr.tbCityId)
    const cep = digitsOf(addr.zipCode)
    const xLgr = (addr.street ?? '').trim(), nro = (addr.nmbr ?? '').trim(), xBairro = (addr.neighborhood ?? '').trim()
    if (cMun && cep.length === 8 && xLgr && nro && xBairro) {
      toma.end = { cMun, cep, xLgr, nro, xBairro, ...(addr.complement ? { xCpl: addr.complement } : {}) }
    }
  }
  // fone/email do tomador: opcionais no XSD; a cadeia não tem e-mail canônico — ficam de fora
  return toma
}

export interface DpsBase {
  /** Tudo do DpsInput menos série/nDPS (cunhados sob lock). */
  input:    Omit<DpsInput, 'serie' | 'nDps'>
  emitter:  EmitterIdentity
}

/** ISO local com fuso do processo (formatDateTimeTz normaliza para o XSD). */
export function nowIsoLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
}

/**
 * Monta o DPS FORA da transação (cadeia, tax e IBGE vão ao pool). O que é do
 * ramo já veio congelado no faturamento; emitente/tomador são lidos agora.
 */
export async function buildDpsBase(
  schemaName: string, institutionId: number, header: ServiceInvoiceHeader, environment: IssuerEnvironment
): Promise<DpsBase> {
  const b = header.branch
  if (!b.nationalCode) {
    throw new HttpError(422, 'Ramo de serviço sem código de tributação nacional (cTribNac) — regra de ISS sem código (D-N11a)',
      [{ field: 'nationalCode', message: 'Obrigatório' }], ErrorCodes.SERVICE_RULE_NATIONAL_CODE_REQUIRED)
  }
  const { identity, prest } = await buildEmitter(schemaName, institutionId)
  const toma = await buildRecipient(header.entityId)
  const cLocPrestacao = await cityIbge(b.cityId)
  if (!cLocPrestacao) {
    throw new HttpError(422, 'Cidade de incidência do serviço sem código IBGE — confira a regra de ISS',
      [{ field: 'cityId', message: 'IBGE ausente' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  // sonda 2026-09-22: cTribMun tem EXATAMENTE 3 dígitos no leiaute — o código municipal do legado
  // ('0102') era CORTADO para '010' (código errado). ACHADO 2 do gate adversarial: omitir em silêncio
  // também é default em fato fiscal (MEDIUM-5) — presente e fora da forma = 422 no campo, ANTES de
  // reservar; ausente = omite (o XSD o deixa opcional). Quem corrige é a regra de ISS (Q-N26).
  // R2-5: a conferência é sobre o VALOR (trimado), nunca sobre os dígitos extraídos — "1-2-3" não é "123"
  const municipalRaw = (b.municipalCode ?? '').trim()
  const municipalDigits = /^\d{3}$/.test(municipalRaw) ? municipalRaw : ''
  if (municipalRaw && !municipalDigits) {
    throw new HttpError(422, `Código de tributação municipal "${b.municipalCode}" fora da forma do DPS (cTribMun = 3 dígitos) — corrija a regra de ISS`,
      [{ field: 'municipalCode', message: 'Esperado 3 dígitos' }], ErrorCodes.FISCAL_DPS_INVALID)
  }
  const tribISSQN = b.liability
  const input: Omit<DpsInput, 'serie' | 'nDps'> = {
    environment, dhEmi: nowIsoLocal(), verAplic: VER_APLIC, dCompet: header.dtEmission,
    tpEmit: '1', cLocEmi: identity.cMunEmi, prest, toma,
    serv: {
      locPrest: { cLocPrestacao },
      cServ: {
        cTribNac: b.nationalCode,
        ...(municipalDigits ? { cTribMun: municipalDigits } : {}),
        xDescServ: (b.description ?? '').trim() || 'Serviços',
      },
    },
    valores: {
      vServ: b.totalValue,
      trib: {
        // D-N8: retenção/exigibilidade vêm congeladas no ramo; alíquota só quando tributável
        tribMun: { tribISSQN, tpRetISSQN: b.issWithheld === 'S' ? '2' : '1', ...(tribISSQN === '1' ? { pAliq: b.aliqIss } : {}) },
        totTrib: { indTotTrib: '0' },
      },
    },
  }
  return { input, emitter: identity }
}

/** Id do DPS desta nota: cMun do EMITENTE + CNPJ + série do emissor SE + nDPS (45 posições). */
export function serviceDpsId(emitter: EmitterIdentity, serie: string | number, nDps: number): string {
  return buildDpsId(emitter.cMunEmi, '2', emitter.cnpj, serie, nDps)
}

/**
 * XML do DPS assinado (Reference = Id do infDPS). LOW-1: erro de montagem/leiaute
 * (CNPJ, IBGE, alíquota fora de TSDec1V2, série…) vira 422 FISCAL_DPS_INVALID com
 * o campo — nunca 500, e nunca fala com o fisco às cegas.
 */
export function buildSignedDps(base: DpsBase, serie: string | number, nDps: number, opened: OpenedIssuer, environment?: IssuerEnvironment): { dpsId: string; xml: string } {
  let dpsId: string, xml: string
  try {
    dpsId = serviceDpsId(base.emitter, serie, nDps)
    xml = buildDpsXml({ ...base.input, environment: environment ?? base.input.environment, serie, nDps }, dpsId)
  } catch (err) {
    if (err instanceof HttpError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new HttpError(422, `DPS inválido: ${msg}`, [{ field: 'dps', message: msg.slice(0, 255) }], ErrorCodes.FISCAL_DPS_INVALID)
  }
  return { dpsId, xml: signLocal(xml, dpsId, opened) }
}

/** R3-7: a assinatura usa a credencial LOCAL — par ilegível/inconsistente é 409 FISCAL_CERT_INVALID, nunca Error cru (500). */
function signLocal(xml: string, referenceId: string, opened: OpenedIssuer): string {
  try {
    return signXml(xml, { referenceId, cert: opened.cert, key: opened.key, algorithm: ADN_SIGN_ALGORITHM })
  } catch (err) {
    if (err instanceof HttpError) throw err
    if (isLocalCredentialError(err)) {
      throw new HttpError(409, 'Certificado/chave do emissor no cofre não assinam (par inconsistente ou ilegível) — envie o .pfx novamente',
        [{ field: 'certificate', message: 'Par PEM inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
    }
    throw err
  }
}

/**
 * Erros do EMISSOR, não da nota (LOW-A do socrático: lote e consulta ativa param pelo MESMO critério):
 * fisco indisponível, credencial recusada pelo fisco, par local inválido, sem habilitação/certificado/vencido.
 */
export const EMITTER_FAILURE_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED, ErrorCodes.FISCAL_CERT_INVALID,
  ErrorCodes.FISCAL_ISSUER_MISSING, ErrorCodes.FISCAL_CERT_MISSING, ErrorCodes.FISCAL_CERT_EXPIRED,
])

/** Pedido de cancelamento e101101 assinado (Reference = Id PRE… do infPedReg). */
export function buildSignedCancel(
  accessKey: string, reason: string, dhEvento: string, environment: IssuerEnvironment, cnpjAutor: string, opened: OpenedIssuer
): { xml: string; xMotivo: string } {
  const xMotivo = normalizeCancelMotive(reason)
  const xml = buildCancelEventXml({ accessKey, dhEvento, cMotivo: CANCEL_MOTIVE_CODE, xMotivo, environment, verAplic: VER_APLIC, cnpjAutor })
  const referenceId = buildEventId(accessKey, '101101')
  return { xml: signLocal(xml, referenceId, opened), xMotivo }
}

/** xMotivo 15–255: motivo curto ganha o complemento padrão; longo é cortado. */
export function normalizeCancelMotive(reason: string): string {
  let m = String(reason ?? '').replace(/\s+/g, ' ').trim()
  if (m.length < XMOTIVO_MIN) m = `${m}${m ? ' — ' : ''}Cancelamento solicitado pelo emissor`
  return m.slice(0, XMOTIVO_MAX)
}

// ---------------------------------------------------------------------------
// Adaptador e contexto mTLS pelo ambiente CONGELADO da tentativa
// ---------------------------------------------------------------------------

export function serviceAdapter(): TaxAuthorityAdapter {
  return adapterFor('ADN')
}

/**
 * Contexto de UMA chamada ao fisco no ambiente `environment` (o da TENTATIVA, congelado —
 * D-N6: a habilitação atual pode ter mudado de ambiente depois da transmissão e a tentativa
 * final continua consultável no HOST em que nasceu). O par PEM é o ÚNICO do
 * estabelecimento (D-N31): serve a H e a P.
 */
export function authorityContextFor(
  _schemaName: string, _institutionId: number, opened: OpenedIssuer, environment: IssuerEnvironment
): AuthorityContext {
  return { environment, cert: opened.cert, key: opened.key }
}

/** Fora da transação (pool) ou DENTRO da reserva com `conn` + FOR UPDATE (MEDIUM-3: ambiente/série congelados dessa leitura). */
export async function openServiceIssuer(schemaName: string, institutionId: number, opts: { conn?: PoolConnection; forUpdate?: boolean } = {}): Promise<OpenedIssuer> {
  return openIssuer(schemaName, institutionId, SERVICE_MODEL, opts)
}

// ---------------------------------------------------------------------------
// Voz do fisco → kind (a composição só conhece o vocabulário de kinds)
// ---------------------------------------------------------------------------

export type AuthorityOutcome = 'rejected' | 'auth_failed' | 'ambiguous' | 'local'

/**
 * Como o erro do transporte se traduz: recusa EXPLÍCITA de regra (422) → R;
 * credencial recusada (409) → F; tudo o mais (503/502/404 ou erro cru de
 * programa) é AMBÍGUO — o fisco PODE ter processado; nada fecha (D-I21).
 */
export function classifyAuthorityError(err: unknown): AuthorityOutcome {
  if (!(err instanceof AuthorityHttpError)) return 'ambiguous'
  if (err.code === ErrorCodes.FISCAL_DPS_REJECTED) return 'rejected'
  if (err.code === ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED) return 'auth_failed'
  if (err.code === ErrorCodes.FISCAL_CERT_INVALID) return 'local'        // D-N30: o fisco nem foi chamado
  return 'ambiguous'
}

export const OUTCOME_KIND: Record<Exclude<AuthorityOutcome, 'ambiguous' | 'local'>, TransmissionEventKind> = { rejected: 'R', auth_failed: 'F' }

/** 1º código E0xxx das rejeições (fields[] "E0718: …"), para `authority_code`. */
export function firstAuthorityCode(err: AuthorityHttpError): string | null {
  for (const f of err.fields ?? []) {
    const m = /\b(E\d{4})\b/.exec(f.message)
    if (m) return m[1]
  }
  const m = /\b(E\d{4})\b/.exec(err.body ?? '')
  return m ? m[1] : (err.authorityStatus ? String(err.authorityStatus) : null)
}

/** Mensagem legível das rejeições, para `message` da voz. */
export function authorityMessage(err: AuthorityHttpError): string {
  const parts = (err.fields ?? []).map(f => f.message).filter(Boolean)
  return (parts.length ? parts.join(' — ') : err.message).slice(0, 255)
}

// ---------------------------------------------------------------------------
// Prazo de cancelamento do PAM (D-N15) — cache em memória 1 h por município
// ---------------------------------------------------------------------------

const TERMS_TTL_MS = 60 * 60 * 1000
const termsCache = new Map<string, { at: number; terms: MunicipalTerms }>()

export async function municipalTermsCached(adapter: TaxAuthorityAdapter, ctx: AuthorityContext, cMun: string): Promise<MunicipalTerms | null> {
  const key = `${ctx.environment}:${cMun}`
  const hit = termsCache.get(key)
  if (hit && Date.now() - hit.at < TERMS_TTL_MS) return hit.terms
  try {
    const terms = await adapter.municipalTerms(ctx, cMun)
    termsCache.set(key, { at: Date.now(), terms })
    return terms
  } catch {
    return null                                   // o prazo é AVISO; a recusa definitiva é a do fisco (E0822)
  }
}

export function resetMunicipalTermsCache(): void { termsCache.clear() }

// ---------------------------------------------------------------------------
// XML em disco: STORAGE_PATH/<cnpj>/<yyyy>/<mm>/<nome> (precedente do sync)
// ---------------------------------------------------------------------------

export function storageRoot(): string {
  return process.env.STORAGE_PATH ?? path.resolve(process.cwd(), 'storage')
}

function monthDir(cnpj: string, when: Date): string {
  return path.join(storageRoot(), digitsOf(cnpj), String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, '0'))
}

/** Grava (mkdir -p) e devolve o caminho. Nome sem separadores por construção (Id/chave são dígitos). */
export function saveFiscalXml(cnpj: string, name: string, xml: string, when = new Date()): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Nome de arquivo fiscal inválido: ${name}`)
  const dir = monthDir(cnpj, when)
  fs.mkdirSync(dir, { recursive: true })
  const full = path.join(dir, name)
  fs.writeFileSync(full, xml, 'utf8')
  return full
}

export const dpsFileName  = (dpsId: string) => `${dpsId}-dps.xml`
export const nfseFileName = (accessKey: string) => `${digitsOf(accessKey)}-nfse.xml`

/**
 * Localiza um XML pelo nome: tenta os meses das datas conhecidas (dhProc,
 * created_at) e, se não achar, varre a pasta do CNPJ (poucas pastas por ano).
 */
export function findFiscalXml(cnpj: string, name: string, hints: (string | null | undefined)[] = []): string | null {
  for (const h of hints) {
    if (!h) continue
    const d = new Date(String(h).replace(' ', 'T'))
    if (Number.isNaN(d.getTime())) continue
    const p = path.join(monthDir(cnpj, d), name)
    if (fs.existsSync(p)) return p
  }
  const root = path.join(storageRoot(), digitsOf(cnpj))
  if (!fs.existsSync(root)) return null
  for (const y of fs.readdirSync(root)) {
    const yd = path.join(root, y)
    if (!fs.statSync(yd).isDirectory()) continue
    for (const m of fs.readdirSync(yd)) {
      const p = path.join(yd, m, name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}
