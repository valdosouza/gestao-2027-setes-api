import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import {
  BankChannelRow, ChannelSecretsStatus, WebhookInfo,
  getBankChannel, upsertBankChannel, softDeleteBankChannel, rotateInboundToken,
  channelSecretsStatus, supportedBankNumbers, secretRef, SECRET_NAMES,
  openBankChannel, openBankChannelForDiagnostics,
} from '@shared/bank-channel'
import {
  writeSecret, deleteSecret, looksLikeCertificatePem, certificateInfo,
  validatePrivateKeyPem, keyMatchesCertificate, hasSecret, readSecret,
} from '@shared/secret-store'
import { countLiveRegistrationsForAccount } from '@shared/bank-slip-registration'
import { getBankAccount } from './bank-accounts.repository'
import { BankChannelDto, BankChannelSecretsDto } from './bank-accounts.channel.dto'

/**
 * Serviço do sub-recurso CANAL API da conta (Onda 2). Regras: a conta é do
 * escopo do JWT; o banco da conta decide o adaptador (derivado); segredos são
 * write-only e só a PRESENÇA/validade volta para a tela.
 */

export interface ChannelScope { schemaName: string; institutionId: number }

export interface ChannelView {
  channel:        Omit<BankChannelRow, 'institutionId'> | null
  secrets:        ChannelSecretsStatus | null
  bankNumber:     string
  adapterSupported: boolean
  /** Caminho público do webhook (a URL completa depende do domínio da Onda 4). */
  webhookPath:    string | null
}

export function webhookPathFor(institutionId: number, inboundToken: string): string {
  return `/hooks/bank-channel/${institutionId}/${inboundToken}`
}

export async function fetchChannel(bankAccountId: number, scope: ChannelScope): Promise<ChannelView> {
  const account = await getBankAccount(bankAccountId, scope.schemaName, scope.institutionId)
  if (!account) throw new HttpError(404, `Conta bancária ${bankAccountId} não encontrada`, undefined, 'BANK_ACCOUNT_NOT_FOUND')
  const bankNumber = String(account.bankNumber ?? '')
  const channel = await getBankChannel(pool, scope.schemaName, scope.institutionId, bankAccountId)
  const { institutionId: _omit, ...rest } = channel ?? ({} as BankChannelRow)
  return {
    channel: channel ? rest : null,
    secrets: channel ? channelSecretsStatus(channel, scope.schemaName) : null,
    bankNumber,
    adapterSupported: supportedBankNumbers().includes(bankNumber),
    webhookPath: channel ? webhookPathFor(scope.institutionId, channel.inboundToken) : null,
  }
}

export async function saveChannel(bankAccountId: number, input: BankChannelDto, scope: ChannelScope): Promise<ChannelView> {
  const account = await getBankAccount(bankAccountId, scope.schemaName, scope.institutionId)
  if (!account) throw new HttpError(404, `Conta bancária ${bankAccountId} não encontrada`, undefined, 'BANK_ACCOUNT_NOT_FOUND')
  const bankNumber = String(account.bankNumber ?? '')
  if (!supportedBankNumbers().includes(bankNumber)) {
    throw new HttpError(422, `Banco ${bankNumber} não tem adaptador de API neste sistema`,
      [{ field: 'bankAccountId', message: `Sem adaptador para o banco ${bankNumber}` }], 'BANK_CHANNEL_NO_ADAPTER')
  }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // D-I27 (Q-I11): virar o ambiente com apresentação VIVA no ambiente atual deixaria
    // cobrança viva no banco que este canal não alcança mais (segredos do sandbox saem
    // do cofre, consulta e cancelamento ficam sem porta). Encerra-as primeiro.
    const current = await getBankChannel(conn, scope.schemaName, scope.institutionId, bankAccountId, true)
    if (current && current.environment !== input.environment) {
      const live = await countLiveRegistrationsForAccount(conn, scope.schemaName, scope.institutionId, bankAccountId, current.environment)
      if (live > 0) {
        throw new HttpError(409, `Conta tem ${live} boleto(s) com apresentação viva no ambiente ${current.environment === 'S' ? 'sandbox' : 'produção'} — encerre-os (liquidar/cancelar) antes de mudar o ambiente`,
          [{ field: 'environment', message: `${live} apresentação(ões) viva(s) em ${current.environment}` }], 'BANK_CHANNEL_HAS_LIVE_REGISTRATIONS')
      }
    }
    await upsertBankChannel(conn, scope.schemaName, scope.institutionId, bankAccountId, {
      environment: input.environment, clientId: input.clientId ?? null, active: input.active,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback(); throw err
  } finally {
    conn.release()
  }
  logger.info('Canal API da conta salvo', { institutionId: scope.institutionId, bankAccountId, environment: input.environment })
  return fetchChannel(bankAccountId, scope)
}

/**
 * D-I26 (Q-I8): excluir o canal com apresentação VIVA no banco é recusado (409) —
 * a cobrança seguiria viva lá sem porta de consulta/cancelamento aqui. Sem viva:
 * soft delete + os segredos dos DOIS ambientes saem do cofre (o PUT seguinte
 * revive o canal com token NOVO — repositório).
 */
export async function removeChannel(bankAccountId: number, scope: ChannelScope): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const channel = await getBankChannel(conn, scope.schemaName, scope.institutionId, bankAccountId, true)
    if (!channel) throw new HttpError(404, 'Canal não encontrado', undefined, 'BANK_CHANNEL_MISSING')
    const live = await countLiveRegistrationsForAccount(conn, scope.schemaName, scope.institutionId, bankAccountId)
    if (live > 0) {
      throw new HttpError(409, `Conta tem ${live} boleto(s) com apresentação viva no banco — encerre-os (liquidar/cancelar) antes de excluir o canal`,
        undefined, 'BANK_CHANNEL_HAS_LIVE_REGISTRATIONS')
    }
    const ok = await softDeleteBankChannel(conn, scope.schemaName, scope.institutionId, bankAccountId)
    if (!ok) throw new HttpError(404, 'Canal não encontrado', undefined, 'BANK_CHANNEL_MISSING')
    await conn.commit()
  } catch (err) {
    await conn.rollback(); throw err
  } finally {
    conn.release()
  }
  // fora da transação (disco): segredos de S e de P — canal excluído não guarda credencial
  for (const environment of ['S', 'P'] as const) {
    for (const name of Object.values(SECRET_NAMES)) deleteSecret(secretRef({ bankAccountId, environment }, scope.schemaName, name))
  }
  logger.info('Canal API da conta excluído (segredos removidos do cofre)', { institutionId: scope.institutionId, bankAccountId })
}

export async function rotateChannelToken(bankAccountId: number, scope: ChannelScope): Promise<ChannelView> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await rotateInboundToken(conn, scope.schemaName, scope.institutionId, bankAccountId)
    await conn.commit()
  } catch (err) {
    await conn.rollback(); throw err
  } finally {
    conn.release()
  }
  return fetchChannel(bankAccountId, scope)
}

/**
 * Segredos WRITE-ONLY. Valida a forma (PEM) antes de gravar; o certificado
 * ainda tem a validade lida para avisar já no upload. Nada do conteúdo volta.
 */
export async function saveChannelSecrets(bankAccountId: number, input: BankChannelSecretsDto, scope: ChannelScope): Promise<ChannelView> {
  const channel = await getBankChannel(pool, scope.schemaName, scope.institutionId, bankAccountId)
  if (!channel) throw new HttpError(409, 'Configure o canal (ambiente e client_id) antes de enviar os segredos', undefined, 'BANK_CHANNEL_MISSING')
  if (input.certificatePem !== undefined) {
    if (!looksLikeCertificatePem(input.certificatePem)) {
      throw new HttpError(400, 'Certificado não está em PEM (-----BEGIN CERTIFICATE-----)',
        [{ field: 'certificatePem', message: 'PEM inválido' }], 'BANK_CHANNEL_SECRET_INVALID')
    }
    try { certificateInfo(input.certificatePem) } catch {
      throw new HttpError(400, 'Certificado PEM ilegível', [{ field: 'certificatePem', message: 'Não pôde ser interpretado' }], 'BANK_CHANNEL_SECRET_INVALID')
    }
    // NÃO grava aqui: só depois de o par cert × chave fechar (M1 do re-score — gravar o
    // cert antes deixava cert novo × chave velha no disco quando o par não casava)
  }
  if (input.privateKeyPem !== undefined) {
    // conteúdo, não só a forma (A7 do gate adversarial / A1 da sonda ao vivo): chave
    // ilegível entrava por cima da boa e toda chamada virava "banco indisponível"
    const why = validatePrivateKeyPem(input.privateKeyPem)
    if (why) throw new HttpError(400, why, [{ field: 'privateKeyPem', message: 'PEM inválido' }], 'BANK_CHANNEL_SECRET_INVALID')
  }
  // par mTLS coerente: chave (nova ou já no cofre) × certificado (novo ou já no cofre)
  const certRef = secretRef(channel, scope.schemaName, SECRET_NAMES.cert)
  const keyRef = secretRef(channel, scope.schemaName, SECRET_NAMES.key)
  const certPem = input.certificatePem ?? (hasSecret(certRef) ? readSecret(certRef).toString() : null)
  const keyPem = input.privateKeyPem ?? (hasSecret(keyRef) ? readSecret(keyRef).toString() : null)
  if (certPem && keyPem && !keyMatchesCertificate(certPem, keyPem)) {
    const field = input.privateKeyPem !== undefined ? 'privateKeyPem' : 'certificatePem'
    throw new HttpError(400, 'A chave privada não corresponde ao certificado — envie o par emitido junto pelo banco',
      [{ field, message: 'Chave e certificado não formam um par' }], 'BANK_CHANNEL_SECRET_INVALID')
  }
  // invariante: cofre = último par VÁLIDO — as duas escritas só depois de toda validação
  if (input.certificatePem !== undefined) writeSecret(certRef, input.certificatePem)
  if (input.privateKeyPem !== undefined) writeSecret(keyRef, input.privateKeyPem)
  if (input.clientSecret !== undefined) {
    writeSecret(secretRef(channel, scope.schemaName, SECRET_NAMES.clientSecret), input.clientSecret.trim())
  }
  logger.info('Segredos do canal atualizados', {
    institutionId: scope.institutionId, bankAccountId, environment: channel.environment,
    certificate: input.certificatePem !== undefined, privateKey: input.privateKeyPem !== undefined, clientSecret: input.clientSecret !== undefined,
  })
  return fetchChannel(bankAccountId, scope)
}

export async function clearChannelSecrets(bankAccountId: number, scope: ChannelScope): Promise<ChannelView> {
  const channel = await getBankChannel(pool, scope.schemaName, scope.institutionId, bankAccountId)
  if (!channel) throw new HttpError(404, 'Canal não encontrado', undefined, 'BANK_CHANNEL_MISSING')
  for (const name of Object.values(SECRET_NAMES)) deleteSecret(secretRef(channel, scope.schemaName, name))
  return fetchChannel(bankAccountId, scope)
}

/** Prova de vida: autentica (token) e lê o webhook cadastrado — não escreve nada no banco. */
export async function testChannel(bankAccountId: number, scope: ChannelScope): Promise<{ ok: true; webhook: WebhookInfo | null; environment: string }> {
  const opened = await openBankChannelForDiagnostics(scope.schemaName, scope.institutionId, bankAccountId)
  const webhook = await opened.adapter.webhookGet(opened.ctx)
  return { ok: true, webhook, environment: opened.channel.environment }
}

export async function fetchBankWebhook(bankAccountId: number, scope: ChannelScope): Promise<WebhookInfo | null> {
  const opened = await openBankChannel(scope.schemaName, scope.institutionId, bankAccountId)
  return opened.adapter.webhookGet(opened.ctx)
}

export async function saveBankWebhook(bankAccountId: number, url: string, scope: ChannelScope): Promise<WebhookInfo | null> {
  const opened = await openBankChannel(scope.schemaName, scope.institutionId, bankAccountId)
  await opened.adapter.webhookPut(opened.ctx, url)
  return opened.adapter.webhookGet(opened.ctx)
}

export async function removeBankWebhook(bankAccountId: number, scope: ChannelScope): Promise<void> {
  const opened = await openBankChannel(scope.schemaName, scope.institutionId, bankAccountId)
  await opened.adapter.webhookDelete(opened.ctx)
}
