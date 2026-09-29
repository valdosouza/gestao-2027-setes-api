import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { InstitutionPayload } from '@shared/types/express'
import { isAdmin } from '@shared/auth/roles'
import { userHasPrivilege } from '@shared/auth/require-privilege'
import { PRIVILEGE_TRANSMITIR } from '@shared/auth/privileges'
import { getEntityFiscalFull } from '@shared/entity'
import { renderDanfse } from '@shared/danfse'
import {
  transmitServiceInvoice, refreshServiceTransmission, refreshOpenServiceTransmissions,
  cancelServiceInvoiceAtAuthority, getServiceFiscalView, readNfseXml, listPendingServiceInvoices,
  TransmitResult, RefreshResult, RefreshRunReport, CancelAtAuthorityResult, ServiceFiscalView,
} from '@shared/invoice-transmission'
import { EMITTER_FAILURE_CODES } from '@shared/invoice-transmission/branches/service'
import { resolveOrderInterface } from './billing.interface-resolver'
import { TransmitBody, TransmitBatchBody, FiscalRefreshBody, FiscalCancelBody } from './billing.dto'

/**
 * Serviço FISCAL do billing (Onda 3 NFS-e): fronteira HTTP ↔ composição
 * `@shared/invoice-transmission`. Nada de regra aqui — só autoria (JWT),
 * privilégio por item no lote e o relatório do lote (nunca 500 por item —
 * padrão do lote da cobrança mensal).
 */

export async function transmitInvoice(institution: InstitutionPayload, body: TransmitBody): Promise<TransmitResult> {
  return transmitServiceInvoice(institution.schemaName, institution.institutionId, institution.userId, body.orderId)
}

export interface TransmitBatchItem {
  orderId:    number
  ok:         boolean
  attempt?:   number
  accessKey?: string | null
  nfseNumber?: string | null
  code?:      string | null
  error?:     string
  /** Rede/fisco fora/contenção: vale tentar de novo na próxima passada. */
  retryable?: boolean
}
export interface TransmitBatchReport {
  requested: number; transmitted: number; failed: number; results: TransmitBatchItem[]
  /** Fisco indisponível: o lote PAROU nos restantes (não insiste — D-I8/fail-closed). */
  stoppedEarly: boolean
}

const RETRYABLE = new Set<string>([
  ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, ErrorCodes.RESOURCE_BUSY, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE,
  ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS,
])
/**
 * Erros do EMISSOR (não da nota): o 2º item já sabe o desfecho — indisponibilidade, credencial recusada
 * pelo fisco (ACHADO 4), par local inválido (D-N30) e emissor sem habilitação/certificado (L6 do socrático).
 */
const STOPS_THE_BATCH = EMITTER_FAILURE_CODES
/** MEDIUM-4: orçamento TOTAL do lote (o fisco leva segundos por DPS) — itens não processados voltam `retryable`. */
export const TRANSMIT_BATCH_BUDGET_MS = 60_000
/** MEDIUM-4/LOW-7: UM lote por institution de cada vez (dois cliques = 409, não dois lotes). */
const runningBatch = new Set<string>()

export async function transmitInvoiceBatch(
  institution: InstitutionPayload, body: TransmitBatchBody, opts: { budgetMs?: number } = {}
): Promise<TransmitBatchReport> {
  const key = `${institution.schemaName}:${institution.institutionId}`
  if (runningBatch.has(key)) {
    throw new HttpError(409, 'Já existe um lote de transmissão em andamento para esta empresa — aguarde o relatório dele', undefined, ErrorCodes.FISCAL_BATCH_RUNNING)
  }
  runningBatch.add(key)
  try {
    return await runTransmitBatch(institution, body, opts.budgetMs ?? TRANSMIT_BATCH_BUDGET_MS)
  } finally {
    runningBatch.delete(key)
  }
}

async function runTransmitBatch(institution: InstitutionPayload, body: TransmitBatchBody, budgetMs: number): Promise<TransmitBatchReport> {
  const ids = [...new Set(body.orderIds)]
  const deadline = Date.now() + budgetMs
  const report: TransmitBatchReport = { requested: ids.length, transmitted: 0, failed: 0, results: [], stoppedEarly: false }
  for (const orderId of ids) {
    if (!report.stoppedEarly && Date.now() >= deadline) report.stoppedEarly = true
    if (report.stoppedEarly) {
      report.results.push({ orderId, ok: false, code: null, error: 'Lote interrompido (fisco indisponível, credencial recusada ou orçamento de tempo esgotado) — item não processado', retryable: true })
      report.failed += 1
      continue
    }
    try {
      // D-E14: TRANSMITIR na interface do RAMO — conferido por item (a rota só conhece o array)
      if (!isAdmin(institution)) {
        const key = await resolveOrderInterface(institution.schemaName, institution.institutionId, orderId)
        if (!(await userHasPrivilege(institution.schemaName, institution.userId, key, PRIVILEGE_TRANSMITIR))) {
          throw new HttpError(403, `Sem privilégio TRANSMITIR na interface ${key}`, undefined, ErrorCodes.PRIVILEGE_REQUIRED)
        }
      }
      const r = await transmitServiceInvoice(institution.schemaName, institution.institutionId, institution.userId, orderId)
      report.results.push({ orderId, ok: true, attempt: r.attempt, accessKey: r.accessKey, nfseNumber: r.nfseNumber })
      report.transmitted += 1
    } catch (err) {
      const code = err instanceof HttpError ? err.code ?? null : (err as any)?.code === 'ER_LOCK_WAIT_TIMEOUT' || (err as any)?.code === 'ER_LOCK_DEADLOCK' ? ErrorCodes.RESOURCE_BUSY : null
      const message = err instanceof Error ? err.message : String(err)
      report.results.push({ orderId, ok: false, code, error: message.slice(0, 255), retryable: !!code && RETRYABLE.has(code) })
      report.failed += 1
      // ACHADO 4 do gate adversarial (lição §10.4 da Onda 2): credencial recusada (handshake mTLS
      // ou 401/403) é do EMISSOR, não da nota — o 2º item já sabe o desfecho; insistir só empilha F
      if (code && STOPS_THE_BATCH.has(code)) report.stoppedEarly = true
    }
  }
  return report
}

export async function refreshInvoice(institution: InstitutionPayload, orderId: number): Promise<RefreshResult> {
  return refreshServiceTransmission(institution.schemaName, institution.institutionId, institution.userId, orderId, 'Q')
}

export async function refreshOpen(institution: InstitutionPayload, body: FiscalRefreshBody): Promise<RefreshRunReport> {
  return refreshOpenServiceTransmissions(institution.schemaName, institution.institutionId, institution.userId,
    { minMinutes: body.minMinutes, limit: body.limit })
}

export async function cancelAtAuthority(institution: InstitutionPayload, body: FiscalCancelBody): Promise<CancelAtAuthorityResult> {
  return cancelServiceInvoiceAtAuthority(institution.schemaName, institution.institutionId, institution.userId, body.orderId, body.reason)
}

export async function fiscalView(institution: InstitutionPayload, orderId: number): Promise<ServiceFiscalView> {
  return getServiceFiscalView(institution.schemaName, institution.institutionId, orderId)
}

export async function fiscalXml(institution: InstitutionPayload, orderId: number): Promise<{ accessKey: string; xml: string }> {
  return readNfseXml(institution.schemaName, institution.institutionId, orderId)
}

export async function fiscalDanfse(institution: InstitutionPayload, orderId: number): Promise<{ accessKey: string; pdfBase64: string }> {
  const { accessKey, xml } = await readNfseXml(institution.schemaName, institution.institutionId, orderId)
  const full = await getEntityFiscalFull(institution.institutionId)
  const issuerName = (full?.entity.nameCompany ?? full?.entity.nickTrade ?? 'Emitente').trim()
  const addr = full?.addresses.find(a => a.main === 'S') ?? full?.addresses[0]
  const municipality = [addr?.cityName, addr?.stateName].filter(Boolean).join(' / ') || '—'
  const pdf = await renderDanfse(xml, { issuerName, municipality })
  return { accessKey, pdfBase64: pdf.toString('base64') }
}

export async function pendingInvoices(institution: InstitutionPayload, limit: number) {
  return listPendingServiceInvoices(institution.schemaName, institution.institutionId, limit)
}
