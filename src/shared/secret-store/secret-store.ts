import fs from 'fs'
import path from 'path'
import { X509Certificate, createPrivateKey } from 'crypto'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/db/schema'

/**
 * PEÇA: guarda de segredos por DONO + FINALIDADE, em arquivos FORA do
 * repositório e fora do banco (Onda 2 da fase Primeiro Cliente — D-I1/D-I3,
 * Valdo 2026-09-19; parecer do guardião conceitual).
 *
 * Por que não coluna: o legado guardava `tb_config_nfe.certificate_pass` em
 * VARCHAR — senha em tabela, replicada em dump, visível em SELECT. Aqui o
 * banco só sabe QUEM tem canal (`tb_bank_account_channel`); o QUE ele usa para
 * falar (client_secret, certificado mTLS, chave privada) vive em
 * `SECRETS_PATH` (irmã do `STORAGE_PATH` das logomarcas), com caminho
 * DERIVADO da identidade — sem coluna de referência, nada a sincronizar:
 *
 *   <SECRETS_PATH>/<schema>/<owner>/<ownerId>/<S|P>/<name>
 *
 * Donos previstos: `bank-account` (canal API da conta — certificado emitido
 * pelo banco) e `establishment` (certificado digital A1 da NFS-e — Onda 3).
 * D-I1: são documentos DIFERENTES, com donos diferentes; a peça é uma, os
 * segredos nunca se misturam nem compartilham campo.
 *
 * Leitura de fora da peça só devolve PRESENÇA e metadados públicos (validade
 * do certificado lida do próprio arquivo — nunca gravada, é derivada). O
 * conteúdo só é lido por quem vai usá-lo na chamada externa. Cofre/KMS entra
 * ATRÁS desta interface quando a produção pedir (Onda 4).
 */

export type SecretOwner = 'bank-account' | 'establishment'
export type SecretEnvironment = 'S' | 'P'

export interface SecretRef {
  schemaName:   string
  owner:        SecretOwner
  ownerId:      number
  environment:  SecretEnvironment
  /** Nome do arquivo (ex.: client.crt, client.key, client_secret). */
  name:         string
}

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const OWNERS: SecretOwner[] = ['bank-account', 'establishment']

export function secretsRoot(): string {
  return process.env.SECRETS_PATH ?? path.resolve(process.cwd(), 'secrets')
}

/** Caminho derivado da identidade — cada componente é validado (nada de `..`). */
export function secretFilePath(ref: SecretRef): string {
  assertSchemaName(ref.schemaName)
  if (!OWNERS.includes(ref.owner)) throw new Error(`secret-store: dono inválido '${ref.owner}'`)
  if (!Number.isInteger(ref.ownerId) || ref.ownerId <= 0) throw new Error('secret-store: ownerId inválido')
  if (ref.environment !== 'S' && ref.environment !== 'P') throw new Error('secret-store: ambiente inválido')
  if (!NAME_RE.test(ref.name)) throw new Error(`secret-store: nome inválido '${ref.name}'`)
  return path.join(secretsRoot(), ref.schemaName, ref.owner, String(ref.ownerId), ref.environment, ref.name)
}

export function hasSecret(ref: SecretRef): boolean {
  try { return fs.statSync(secretFilePath(ref)).isFile() } catch { return false }
}

/**
 * Lê o conteúdo — SÓ para uso imediato na chamada externa. Ausente → 409 com
 * código próprio (o operador resolve na aba do canal; nunca 500).
 */
export function readSecret(ref: SecretRef, missingCode = 'SECRET_MISSING'): Buffer {
  const file = secretFilePath(ref)
  try {
    return fs.readFileSync(file)
  } catch {
    throw new HttpError(409, `Segredo '${ref.name}' não configurado para ${ref.owner} ${ref.ownerId} (${ref.environment})`,
      [{ field: ref.name, message: 'Arquivo ausente no cofre de segredos' }], missingCode)
  }
}

/** Grava (0600) criando a árvore; sobrescreve — trocar certificado é ato normal. */
export function writeSecret(ref: SecretRef, content: Buffer | string): void {
  const file = secretFilePath(ref)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode: 0o600 })
}

export function deleteSecret(ref: SecretRef): boolean {
  const file = secretFilePath(ref)
  try { fs.unlinkSync(file); return true } catch { return false }
}

export interface CertificateInfo {
  subject:        string
  issuer:         string
  notBefore:      string
  notAfter:       string
  /** Dias até expirar (negativo = expirado). */
  daysToExpire:   number
  fingerprint256: string
  expired:        boolean
}

/** Metadados PÚBLICOS de um certificado PEM — o que a tela pode mostrar. */
export function certificateInfo(pem: Buffer | string, now: Date = new Date()): CertificateInfo {
  const cert = new X509Certificate(pem)
  const notAfter = new Date(cert.validTo)
  const days = Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000)
  return {
    subject: cert.subject.replace(/\n/g, ', '),
    issuer:  cert.issuer.replace(/\n/g, ', '),
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter:  notAfter.toISOString(),
    daysToExpire: days,
    fingerprint256: cert.fingerprint256,
    expired: days < 0,
  }
}

/** PEM de certificado? (validação de upload — sem tentar interpretar chave). */
export function looksLikeCertificatePem(content: Buffer | string): boolean {
  return /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(content.toString())
}
export function looksLikePrivateKeyPem(content: Buffer | string): boolean {
  return /-----BEGIN (RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (RSA |EC )?PRIVATE KEY-----/.test(content.toString())
}

/**
 * A chave ABRE no OpenSSL? null = ok; string = motivo. Só o cabeçalho PEM era
 * conferido no upload: uma chave com corpo lixo entrava no cofre por cima da boa, o
 * canal parecia "completo" e toda chamada ao banco virava "indisponível" (sonda ao
 * vivo do gate da Onda 2, A1). Write-only exige validar ANTES de gravar.
 */
export function validatePrivateKeyPem(content: Buffer | string): string | null {
  if (!looksLikePrivateKeyPem(content)) return 'Chave privada não está em PEM (-----BEGIN PRIVATE KEY-----)'
  try { createPrivateKey({ key: content.toString(), format: 'pem' }); return null }
  catch (e: any) { return `Chave privada ilegível (${String(e?.code ?? e?.message ?? 'PEM inválido')})` }
}

/** A chave é a deste certificado? (par mTLS coerente antes de ir ao banco) */
export function keyMatchesCertificate(certPem: Buffer | string, keyPem: Buffer | string): boolean {
  try { return new X509Certificate(certPem).checkPrivateKey(createPrivateKey({ key: keyPem.toString(), format: 'pem' })) }
  catch { return false }
}
