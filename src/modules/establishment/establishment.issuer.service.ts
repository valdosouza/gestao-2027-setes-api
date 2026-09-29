import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import logger from '@shared/logger/logger'
import {
  IssuerModel, IssuerEnvironment, IssuerAuthority, IssuerCertificateStatus,
  authorityOf, isIssuerEnabled, issuerCertificateStatus, storeIssuerCertificate, clearIssuerCertificate,
  listIssuers, getIssuer, upsertIssuer, softDeleteIssuer, countLiveServiceTransmissions,
} from '@shared/fiscal-issuer'
import { IssuerDto, IssuerCertificateDto } from './establishment.issuer.dto'
import { DPS_SERIE_MIN, DPS_SERIE_MAX } from '@shared/tax-authority/dps-builder'
import { getEntityFiscalFull } from '@shared/entity'

/**
 * Serviço do sub-recurso EMISSOR FISCAL do próprio estabelecimento (Onda 3,
 * conceito A). Regras: o estabelecimento é o do JWT (nunca :id); a autoridade é
 * derivada do modelo; o certificado é do AMBIENTE (serve a todos os modelos);
 * "habilitado" é derivado; segredos são write-only e só presença/validade
 * voltam para a tela.
 */

export interface IssuerScope { schemaName: string; institutionId: number; userId: number | null }

export interface IssuerItemView {
  model:       IssuerModel
  environment: IssuerEnvironment
  serie:       string
  enabled:     boolean
  authority:   IssuerAuthority
}

export interface IssuerView {
  issuers:     IssuerItemView[]
  /** D-N31: UM certificado A1 por estabelecimento — serve a homologação e a produção. */
  certificate: IssuerCertificateStatus
}

/** Modelos que a habilitação aceita HOJE; 65 nasce na onda do PDV (D-E16). */
const SUPPORTED_MODELS: readonly IssuerModel[] = ['SE', '55']

function assertSupportedModel(model: IssuerModel): void {
  if (!SUPPORTED_MODELS.includes(model)) {
    throw new HttpError(422, `Modelo ${model} ainda não é suportado pela habilitação do emissor (onda do PDV)`,
      [{ field: 'model', message: 'Modelo não suportado' }], ErrorCodes.FISCAL_MODEL_NOT_SUPPORTED)
  }
}


/** Série normalizada sem zeros à esquerda; para SE, dentro do padrão nacional (1–49999). */
function normalizeSerie(model: IssuerModel, raw: string): string {
  const n = Number(raw)
  if (model === 'SE' && (n < DPS_SERIE_MIN || n > DPS_SERIE_MAX)) {
    throw new HttpError(422, `Série do DPS deve estar entre ${DPS_SERIE_MIN} e ${DPS_SERIE_MAX}`,
      [{ field: 'serie', message: `Entre ${DPS_SERIE_MIN} e ${DPS_SERIE_MAX}` }], ErrorCodes.VALIDATION_FAILED)
  }
  return String(n)
}

export async function fetchIssuerView(scope: IssuerScope): Promise<IssuerView> {
  const rows = await listIssuers(scope.schemaName, scope.institutionId)
  const certificate = issuerCertificateStatus(scope.schemaName, scope.institutionId)
  return {
    issuers: rows.map(r => ({
      model: r.model, environment: r.environment, serie: r.serie,
      enabled: isIssuerEnabled(certificate), authority: authorityOf(r.model),
    })),
    certificate,
  }
}

/**
 * Cria/altera a habilitação do modelo. Mudar o AMBIENTE com transmissão VIVA no
 * ambiente atual deixaria DPS esperando a voz do fisco num ambiente que a
 * habilitação não alcança mais — recusa 409 (só SE: 55 ainda não transmite).
 * Linha lida FOR UPDATE dentro da transação (padrão do canal bancário, D-I27).
 */
export async function saveIssuer(model: IssuerModel, input: IssuerDto, scope: IssuerScope): Promise<IssuerView> {
  assertSupportedModel(model)
  const serie = normalizeSerie(model, input.serie)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const current = await getIssuer(conn, scope.schemaName, scope.institutionId, model, true)
    if (current && current.environment !== input.environment && model === 'SE') {
      const live = await countLiveServiceTransmissions(conn, scope.schemaName, scope.institutionId, current.environment)
      if (live > 0) {
        throw new HttpError(409, `Emissor tem ${live} transmissão(ões) viva(s) no ambiente ${current.environment === 'P' ? 'produção' : 'homologação'} — aguarde a voz do fisco antes de mudar o ambiente`,
          [{ field: 'environment', message: `${live} transmissão(ões) viva(s) em ${current.environment}` }],
          ErrorCodes.FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS)
      }
    }
    await upsertIssuer(conn, scope.schemaName, scope.institutionId, model, {
      environment: input.environment, serie, userId: scope.userId,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback(); throw err
  } finally {
    conn.release()
  }
  logger.info('Habilitação do emissor fiscal salva', { institutionId: scope.institutionId, model, environment: input.environment, serie })
  return fetchIssuerView(scope)
}

/**
 * Soft delete da habilitação do modelo. Transmissão viva (qualquer ambiente)
 * prende a linha (409). NÃO apaga o certificado: ele é do ESTABELECIMENTO e serve aos
 * outros modelos — apagá-lo é ato próprio (DELETE /issuer/certificate).
 */
export async function removeIssuer(model: IssuerModel, scope: IssuerScope): Promise<IssuerView> {
  assertSupportedModel(model)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const current = await getIssuer(conn, scope.schemaName, scope.institutionId, model, true)
    if (!current) {
      throw new HttpError(404, `Estabelecimento não tem habilitação do emissor para o modelo ${model}`, undefined, ErrorCodes.FISCAL_ISSUER_MISSING)
    }
    if (model === 'SE') {
      const live = await countLiveServiceTransmissions(conn, scope.schemaName, scope.institutionId)
      if (live > 0) {
        throw new HttpError(409, `Emissor tem ${live} transmissão(ões) viva(s) no fisco — aguarde a voz do fisco antes de excluir a habilitação`,
          undefined, ErrorCodes.FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS)
      }
    }
    await softDeleteIssuer(conn, scope.schemaName, scope.institutionId, model)
    await conn.commit()
  } catch (err) {
    await conn.rollback(); throw err
  } finally {
    conn.release()
  }
  logger.info('Habilitação do emissor fiscal excluída (certificado do estabelecimento mantido)', { institutionId: scope.institutionId, model })
  return fetchIssuerView(scope)
}

export type IssuerCertificateView = IssuerCertificateStatus

const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

/**
 * Upload WRITE-ONLY do A1: base64 → .pfx → (peça) PKCS#12 aberto com a senha →
 * par PEM validado → cofre do estabelecimento (D-N31: um só, para H e P). Senha e
 * .pfx morrem com a requisição.
 */
export async function saveIssuerCertificate(input: IssuerCertificateDto, scope: IssuerScope): Promise<IssuerCertificateView> {
  if (!BASE64_RE.test(input.pfxBase64)) {
    throw new HttpError(400, 'Arquivo .pfx precisa vir em base64', [{ field: 'pfxBase64', message: 'base64 inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  const pfx = Buffer.from(input.pfxBase64, 'base64')
  if (pfx.length === 0) {
    throw new HttpError(400, 'Arquivo .pfx vazio', [{ field: 'pfxBase64', message: 'base64 inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  // D-N29: o A1 tem que ser do CNPJ do emitente (a institution como pessoa jurídica)
  const full = await getEntityFiscalFull(scope.institutionId)
  const status = storeIssuerCertificate(scope.schemaName, scope.institutionId, pfx, input.password,
    { expectedCnpj: full?.company?.cnpj ?? null })
  logger.info('Certificado A1 do emissor atualizado no cofre', {
    institutionId: scope.institutionId,
    cnpj: status.certificateInfo?.cnpj ?? null, notAfter: status.certificateInfo?.notAfter ?? null,
  })
  return status
}

export async function removeIssuerCertificate(scope: IssuerScope): Promise<IssuerCertificateView> {
  const status = clearIssuerCertificate(scope.schemaName, scope.institutionId)
  logger.info('Certificado A1 do emissor removido do cofre', { institutionId: scope.institutionId })
  return status
}
