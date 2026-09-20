import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import {
  SecretRef, hasSecret, readSecret, certificateInfo,
} from '@shared/secret-store'
import { AdapterContext, BankChargeAdapter, BankChannelRow, ChannelEnvironment, ChannelSecrets, ChannelSecretsStatus } from './types'
import { getBankChannel } from './bank-channel.repository'
import { interAdapter } from './adapters/inter'

/**
 * PEÇA @shared/bank-channel — "esta conta corrente fala com o seu banco por
 * API" (Onda 2, D-I2…D-I15). Resolve o canal da conta, lê os segredos pela
 * secret-store, escolhe o ADAPTADOR pelo número FEBRABAN do banco da conta
 * (derivado — nunca coluna) e entrega um contexto para UMA chamada. Não conhece
 * boleto: quem interpreta as respostas é a composição @shared/bank-slip-registration.
 *
 * Amanhã o mesmo canal ganha `statement()`/`balance()` (API Banking) sem mudar
 * de forma — por isso a credencial é da CONTA, não da carteira.
 */

const ADAPTERS: Record<string, BankChargeAdapter> = {
  [interAdapter.bankNumber]: interAdapter,
}

/** Bancos com adaptador (a tela usa para dizer "este banco não tem canal API"). */
export function supportedBankNumbers(): string[] { return Object.keys(ADAPTERS) }

export function resolveAdapter(bankNumber: string): BankChargeAdapter {
  const a = ADAPTERS[bankNumber]
  if (!a) {
    throw new HttpError(422, `Banco ${bankNumber} não tem adaptador de API neste sistema`,
      [{ field: 'bankAccountId', message: `Sem adaptador para o banco ${bankNumber}` }], 'BANK_CHANNEL_NO_ADAPTER')
  }
  return a
}

export const SECRET_NAMES = { cert: 'client.crt', key: 'client.key', clientSecret: 'client_secret' } as const

export function secretRef(channel: Pick<BankChannelRow, 'bankAccountId' | 'environment'>, schemaName: string, name: string): SecretRef {
  return { schemaName, owner: 'bank-account', ownerId: channel.bankAccountId, environment: channel.environment, name }
}

/** Presença e validade — o que a aba Canal API mostra (nunca conteúdo). */
export function channelSecretsStatus(channel: BankChannelRow, schemaName: string): ChannelSecretsStatus {
  const cert = hasSecret(secretRef(channel, schemaName, SECRET_NAMES.cert))
  let info: ChannelSecretsStatus['certificateInfo'] = null
  if (cert) {
    try {
      const i = certificateInfo(readSecret(secretRef(channel, schemaName, SECRET_NAMES.cert)))
      info = { subject: i.subject, issuer: i.issuer, notAfter: i.notAfter, daysToExpire: i.daysToExpire, expired: i.expired }
    } catch { info = null }
  }
  return {
    certificate: cert,
    privateKey: hasSecret(secretRef(channel, schemaName, SECRET_NAMES.key)),
    clientSecret: hasSecret(secretRef(channel, schemaName, SECRET_NAMES.clientSecret)),
    certificateInfo: info,
  }
}

function loadSecrets(channel: BankChannelRow, schemaName: string): ChannelSecrets {
  const cert = readSecret(secretRef(channel, schemaName, SECRET_NAMES.cert), 'BANK_CHANNEL_SECRET_MISSING')
  const key  = readSecret(secretRef(channel, schemaName, SECRET_NAMES.key), 'BANK_CHANNEL_SECRET_MISSING')
  const clientSecret = readSecret(secretRef(channel, schemaName, SECRET_NAMES.clientSecret), 'BANK_CHANNEL_SECRET_MISSING').toString('utf8').trim()
  const info = certificateInfo(cert)
  if (info.expired) {
    throw new HttpError(409, `Certificado do canal expirou em ${info.notAfter.slice(0, 10)} — renove no banco e envie o novo`,
      [{ field: 'certificate', message: 'Expirado' }], 'BANK_CHANNEL_CERT_EXPIRED')
  }
  return { cert, key, clientSecret }
}

export interface OpenedChannel {
  channel: BankChannelRow
  adapter: BankChargeAdapter
  ctx:     AdapterContext
}

/**
 * Abre o canal da conta para chamadas: canal existente e ativo, adaptador do
 * banco, segredos presentes e certificado válido. Cada ausência é um 409/422
 * legível com código próprio — nunca 500 e nunca chamada ao banco às cegas.
 * Leitura pelo pool ou por uma conexão (dentro de transação, `FOR UPDATE`
 * quando a decisão gravar algo).
 */
export async function openBankChannel(
  schemaName: string, institutionId: number, bankAccountId: number,
  opts: { conn?: PoolConnection; forUpdate?: boolean; environment?: ChannelEnvironment } = {}
): Promise<OpenedChannel> {
  const found = await getBankChannel(opts.conn ?? pool, schemaName, institutionId, bankAccountId, opts.forUpdate ?? false)
  if (!found) {
    throw new HttpError(409, `Conta bancária ${bankAccountId} não tem canal API configurado`,
      [{ field: 'bankAccountId', message: 'Configure o canal API na conta' }], 'BANK_CHANNEL_MISSING')
  }
  if (found.active !== 'S') {
    throw new HttpError(409, `Canal API da conta ${bankAccountId} está inativo`,
      [{ field: 'bankAccountId', message: 'Canal inativo' }], 'BANK_CHANNEL_INACTIVE')
  }
  // Uma apresentação CONGELA o ambiente em que nasceu (migration 055): consultar
  // um código do sandbox depois de o canal virar produção precisa falar com o
  // sandbox — e com os segredos DELE.
  const channel: BankChannelRow = opts.environment && opts.environment !== found.environment
    ? { ...found, environment: opts.environment } : found
  const adapter = resolveAdapter(channel.bankNumber)
  const secrets = loadSecrets(channel, schemaName)
  return { channel, adapter, ctx: { channel, secrets } }
}

/** Abertura sem exigir `active` (testar credenciais de um canal pausado, tela). */
export async function openBankChannelForDiagnostics(
  schemaName: string, institutionId: number, bankAccountId: number
): Promise<OpenedChannel> {
  const channel = await getBankChannel(pool, schemaName, institutionId, bankAccountId)
  if (!channel) {
    throw new HttpError(409, `Conta bancária ${bankAccountId} não tem canal API configurado`,
      [{ field: 'bankAccountId', message: 'Configure o canal API na conta' }], 'BANK_CHANNEL_MISSING')
  }
  const adapter = resolveAdapter(channel.bankNumber)
  return { channel, adapter, ctx: { channel, secrets: loadSecrets(channel, schemaName) } }
}
