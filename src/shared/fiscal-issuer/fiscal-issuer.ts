import { PoolConnection } from 'mysql2/promise'
import forge from 'node-forge'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import {
  SecretRef, SecretEnvironment, hasSecret, readSecret, writeSecret, deleteSecret,
  certificateInfo, validatePrivateKeyPem, keyMatchesCertificate,
} from '@shared/secret-store'
import { getIssuer } from './fiscal-issuer.repository'

/**
 * PEÇA @shared/fiscal-issuer — "este estabelecimento fala com o fisco com o SEU
 * certificado A1, num ambiente" (conceito A da Onda 3 NFS-e / NF-e — D-N4, D-N5,
 * D-N6, D-E1, D-E4; migration 058).
 *
 * - A linha (`tb_establishment_issuer`) é por MODELO do documento (SE · 55 · 65);
 *   a AUTORIDADE é derivada do modelo (SE → Sefin Nacional/ADN; 55/65 → SEFAZ),
 *   nunca coluna.
 * - O certificado A1 é do ESTABELECIMENTO — UM só, para homologação E produção
 *   (D-N31, Valdo 2026-09-28: o mesmo A1 vale nos dois ambientes do fisco; a D-N6
 *   continua valendo para o HOST congelado da tentativa, não para o certificado).
 *   Vive no cofre (`@shared/secret-store`, owner `establishment`, ownerId =
 *   institution) como par PEM e serve a TODOS os modelos.
 * - "Habilitado" é DERIVADO: linha viva + par presente, certificado vigente e não
 *   vencido. Não existe `active`.
 * - O `.pfx` e a senha existem SÓ na requisição do upload: a peça abre o PKCS#12,
 *   valida o par e grava APENAS os PEMs. Senha nunca vira arquivo, coluna ou log.
 */

export type IssuerModel = 'SE' | '55' | '65'
export type IssuerEnvironment = 'H' | 'P'
export type IssuerAuthority = 'ADN' | 'SEFAZ'

export const ISSUER_MODELS: readonly IssuerModel[] = ['SE', '55', '65']
export const ISSUER_ENVIRONMENTS: readonly IssuerEnvironment[] = ['H', 'P']

export interface IssuerRow {
  institutionId: number
  model:         IssuerModel
  environment:   IssuerEnvironment
  serie:         string
  userId:        number | null
}

export interface IssuerInput {
  environment: IssuerEnvironment
  serie:       string
  userId:      number | null
}

/** Autoridade fiscal DERIVADA do modelo — mapa constante, nunca coluna (D-E1). */
export function authorityOf(model: IssuerModel): IssuerAuthority {
  return model === 'SE' ? 'ADN' : 'SEFAZ'
}

/**
 * D-N31: o A1 é UM por estabelecimento (serve a H e a P). A secret-store exige uma pasta
 * de ambiente ('S' | 'P'); o par do emissor vive SEMPRE em 'P' — uma constante só, para o
 * caminho no disco nunca depender de quem chama.
 */
export const ISSUER_SECRET_ENVIRONMENT: SecretEnvironment = 'P'

export const ISSUER_SECRET_NAMES = { cert: 'certificate.pem', key: 'private.key' } as const

export function issuerSecretRef(schemaName: string, institutionId: number, name: string): SecretRef {
  return { schemaName, owner: 'establishment', ownerId: institutionId, environment: ISSUER_SECRET_ENVIRONMENT, name }
}

export interface IssuerCertificateInfo {
  subject:      string
  issuer:       string
  /** Início da vigência (ISO) — a tela mostra "só vale a partir de" quando `notYetValid`. */
  notBefore:    string
  notAfter:     string
  daysToExpire: number
  expired:      boolean
  /** R2-4: ainda não vigente (notBefore no futuro) — o handshake recusaria com CERT_NOT_YET_VALID. */
  notYetValid:  boolean
  /** CNPJ lido do CN do e-CNPJ (ICP-Brasil: "RAZAO SOCIAL:CNPJ"); null quando o CN não traz. */
  cnpj:         string | null
}

/** Situação do cofre do estabelecimento — o que a aba "Emissor fiscal" mostra (nunca conteúdo). */
export interface IssuerCertificateStatus {
  certificate:     boolean
  privateKey:      boolean
  certificateInfo: IssuerCertificateInfo | null
}

/** CNPJ do CN no padrão ICP-Brasil ("NOME:14 dígitos"); null se o CN não segue o padrão. */
export function cnpjFromSubject(subject: string): string | null {
  const m = /:(\d{14})(?!\d)/.exec(cnValueOf(subject) ?? '')
  return m ? m[1] : null
}

/** Só o VALOR da RDN CN (R3-5: a regex antiga atravessava para OU/O e atribuía ao CN um ":CNPJ" alheio). */
function cnValueOf(subject: string): string | null {
  const m = /(?:^|\n|, )CN=([^\n]*?)(?=(?:, [A-Z]+=)|\n|$)/.exec(subject)
  return m ? m[1] : null
}

/** CPF do CN no padrão ICP-Brasil do e-CPF ("NOME:11 dígitos") — R3-4: identificável como "não é este CNPJ". */
export function cpfFromSubject(subject: string): string | null {
  const m = /:(\d{11})(?!\d)/.exec(cnValueOf(subject) ?? '')
  return m ? m[1] : null
}

function notBeforeOf(pem: Buffer | string): string {
  try { return certificateInfo(pem).notBefore.slice(0, 10) } catch { return '?' }
}

function toIssuerInfo(pem: Buffer | string): IssuerCertificateInfo {
  const i = certificateInfo(pem)
  return {
    subject: i.subject, issuer: i.issuer, notBefore: i.notBefore, notAfter: i.notAfter,
    daysToExpire: i.daysToExpire, expired: i.expired, notYetValid: i.notYetValid, cnpj: cnpjFromSubject(i.subject),
  }
}

export function issuerCertificateStatus(schemaName: string, institutionId: number): IssuerCertificateStatus {
  const certRef = issuerSecretRef(schemaName, institutionId, ISSUER_SECRET_NAMES.cert)
  const keyRef  = issuerSecretRef(schemaName, institutionId, ISSUER_SECRET_NAMES.key)
  const certificate = hasSecret(certRef)
  let info: IssuerCertificateInfo | null = null
  if (certificate) {
    try { info = toIssuerInfo(readSecret(certRef)) } catch { info = null }
  }
  return { certificate, privateKey: hasSecret(keyRef), certificateInfo: info }
}

/** Habilitado = linha + par no cofre do estabelecimento + certificado legível, vigente e não vencido (D-E4/D-N31). */
export function isIssuerEnabled(status: IssuerCertificateStatus): boolean {
  return status.certificate && status.privateKey && status.certificateInfo !== null && !status.certificateInfo.expired && !status.certificateInfo.notYetValid
}

export interface OpenedIssuer {
  issuer: IssuerRow
  cert:   Buffer
  key:    Buffer
  info:   IssuerCertificateInfo
}

/**
 * Abre o emissor de um modelo para UMA chamada ao fisco: linha viva, par no cofre
 * do ambiente da linha, certificado válido. Cada ausência é um 409 legível com
 * código próprio, nesta ordem — nunca 500 e nunca chamada ao fisco às cegas.
 * Leitura pelo pool ou por uma conexão (dentro de transação, `FOR UPDATE`
 * quando a decisão gravar algo — ex.: cunhar nDPS).
 */
export async function openIssuer(
  schemaName: string, institutionId: number, model: IssuerModel,
  opts: { conn?: PoolConnection; forUpdate?: boolean } = {}
): Promise<OpenedIssuer> {
  const issuer = await getIssuer(opts.conn ?? pool, schemaName, institutionId, model, opts.forUpdate ?? false)
  if (!issuer) {
    throw new HttpError(409, `Estabelecimento sem habilitação do emissor para o modelo ${model}`,
      [{ field: 'model', message: 'Configure ambiente e série na aba Emissor fiscal' }], ErrorCodes.FISCAL_ISSUER_MISSING)
  }
  const certRef = issuerSecretRef(schemaName, institutionId, ISSUER_SECRET_NAMES.cert)
  const keyRef  = issuerSecretRef(schemaName, institutionId, ISSUER_SECRET_NAMES.key)
  if (!hasSecret(certRef) || !hasSecret(keyRef)) {
    throw new HttpError(409, 'Certificado digital A1 do estabelecimento ausente no cofre',
      [{ field: 'certificate', message: 'Envie o .pfx na aba Emissor fiscal' }], ErrorCodes.FISCAL_CERT_MISSING)
  }
  const cert = readSecret(certRef, ErrorCodes.FISCAL_CERT_MISSING)
  const key  = readSecret(keyRef, ErrorCodes.FISCAL_CERT_MISSING)
  let info: IssuerCertificateInfo
  try { info = toIssuerInfo(cert) } catch {
    throw new HttpError(409, 'Certificado do emissor no cofre está ilegível — envie o .pfx novamente',
      [{ field: 'certificate', message: 'PEM ilegível' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  if (info.expired) {
    throw new HttpError(409, `Certificado digital A1 do emissor expirou em ${info.notAfter.slice(0, 10)} — renove e envie o novo`,
      [{ field: 'certificate', message: 'Expirado' }], ErrorCodes.FISCAL_CERT_EXPIRED)
  }
  if (info.notYetValid) {
    throw new HttpError(409, `Certificado digital A1 do emissor só vale a partir de ${notBeforeOf(cert)} — ainda não pode falar com o fisco`,
      [{ field: 'certificate', message: 'Ainda não vigente' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  // R3-7: a CHAVE também se valida ao abrir — chave ilegível no cofre estourava cru na assinatura (500 por nota)
  const keyWhy = validatePrivateKeyPem(key)
  if (keyWhy) {
    throw new HttpError(409, `Chave privada do emissor no cofre está ilegível (${keyWhy}) — envie o .pfx novamente`,
      [{ field: 'certificate', message: 'Chave privada ilegível' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  return { issuer, cert, key, info }
}

// ---------------------------------------------------------------------------
// Upload do A1: PKCS#12 → par PEM (D-N5)
// ---------------------------------------------------------------------------

function invalidPfx(message: string): HttpError {
  return new HttpError(400, message, [{ field: 'pfx', message: 'PKCS#12 inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
}

/**
 * Abre o PKCS#12 com a senha e devolve o certificado FOLHA (o que casa com a chave
 * privada — a cadeia da AC é ignorada) e a chave, ambos em PEM. Senha errada, arquivo
 * que não é PKCS#12, sem chave ou sem certificado correspondente → 400 no campo `pfx`.
 * A senha só existe aqui, no escopo desta função.
 */
export function pkcs12ToPem(pfx: Buffer, password: string): { certPem: string; keyPem: string } {
  let p12: forge.pkcs12.Pkcs12Pfx
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')))
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password)
  } catch {
    throw invalidPfx('Arquivo não é um PKCS#12 válido ou a senha está incorreta')
  }
  const oids = forge.pki.oids
  const keyBags = [
    ...(p12.getBags({ bagType: oids.pkcs8ShroudedKeyBag })[oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: oids.keyBag })[oids.keyBag] ?? []),
  ]
  const key = keyBags.find(b => b.key)?.key
  if (!key) throw invalidPfx('PKCS#12 sem chave privada')
  const certs = (p12.getBags({ bagType: oids.certBag })[oids.certBag] ?? [])
    .map(b => b.cert).filter((c): c is forge.pki.Certificate => !!c)
  const matching = certs.filter(c => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey
    return !!pub?.n && pub.n.compareTo(key.n) === 0 && pub.e.compareTo(key.e) === 0
  })
  // ACHADO 6 do gate adversarial: renovação que reaproveitou o par deixa DOIS certificados da
  // mesma chave no .pfx (vencido + válido) — o cofre fica com o VIGENTE agora; empate = o que
  // vence por último (nunca "o 1º que casa", que podia ser o vencido → 409 injusto)
  const now = Date.now()
  const validNow = (c: forge.pki.Certificate) => c.validity.notBefore.getTime() <= now && now <= c.validity.notAfter.getTime()
  const leaf = [...matching].sort((a, b) =>
    Number(validNow(b)) - Number(validNow(a)) || b.validity.notAfter.getTime() - a.validity.notAfter.getTime())[0]
  if (!leaf) throw invalidPfx('PKCS#12 sem certificado correspondente à chave privada')
  return { certPem: forge.pki.certificateToPem(leaf), keyPem: forge.pki.privateKeyToPem(key) }
}

/**
 * Recebe o `.pfx` + senha, converte, VALIDA o par inteiro (certificado legível,
 * chave abre no OpenSSL, chave casa com o certificado, não vencido) e SÓ ENTÃO
 * grava os dois arquivos — invariante "cofre = último par válido": nunca escreve
 * um antes de validar o outro. Vencido → 409 sem gravar. Devolve a situação do
 * cofre (nunca o conteúdo).
 */
export function storeIssuerCertificate(
  schemaName: string, institutionId: number, pfx: Buffer, password: string,
  opts: { expectedCnpj?: string | null } = {}
): IssuerCertificateStatus {
  const { certPem, keyPem } = pkcs12ToPem(pfx, password)
  let info: IssuerCertificateInfo
  try { info = toIssuerInfo(certPem) } catch { throw invalidPfx('Certificado do PKCS#12 ilegível') }
  const why = validatePrivateKeyPem(keyPem)
  if (why) throw invalidPfx(why)
  if (!keyMatchesCertificate(certPem, keyPem)) throw invalidPfx('A chave privada não corresponde ao certificado')
  if (info.expired) {
    throw new HttpError(409, `Certificado digital A1 expirou em ${info.notAfter.slice(0, 10)} — renove e envie o novo`,
      [{ field: 'pfx', message: 'Expirado' }], ErrorCodes.FISCAL_CERT_EXPIRED)
  }
  if (info.notYetValid) {
    // R2-4: só vale amanhã — o fisco recusaria o handshake (CERT_NOT_YET_VALID) nota a nota
    throw new HttpError(409, `Certificado digital A1 só vale a partir de ${notBeforeOf(certPem)} — envie quando estiver vigente`,
      [{ field: 'pfx', message: 'Ainda não vigente' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  // D-N29 (MEDIUM-3 do socrático): sem procuração (D-N12) o A1 tem que ser do CNPJ do EMITENTE —
  // um .pfx de outra empresa "habilita" a tela e o fisco recusa nota a nota (R por assinatura ≠ prestador)
  const expected = String(opts.expectedCnpj ?? '').replace(/\D/g, '')
  if (expected.length === 14 && info.cnpj && info.cnpj !== expected) {
    throw new HttpError(409, `Certificado do CNPJ ${info.cnpj} — o estabelecimento é ${expected}; o A1 tem que ser do emitente`,
      [{ field: 'pfx', message: 'CNPJ do certificado ≠ CNPJ do estabelecimento' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  // R3-4: e-CPF está no padrão ICP-Brasil (NOME:CPF) — é identificável como "não é este CNPJ"
  if (expected.length === 14 && !info.cnpj && cpfFromSubject(info.subject)) {
    throw new HttpError(409, 'Certificado é um e-CPF — sem procuração (D-N12) o A1 tem que ser o e-CNPJ do emitente',
      [{ field: 'pfx', message: 'e-CPF não serve para o emitente' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  // Q-N29 reforço (Valdo 2026-09-28, "siga as recomendações"): fail-closed — CN sem os 14 dígitos do padrão
  // ICP-Brasil não é e-CNPJ; sem procuração, só o e-CNPJ do emitente serve. Entra apenas quando não há
  // com o que comparar (expectedCnpj ausente — testes de peça).
  if (expected.length === 14 && !info.cnpj) {
    throw new HttpError(409, 'Certificado sem CNPJ no CN (padrão ICP-Brasil "RAZÃO SOCIAL:CNPJ") — o A1 tem que ser o e-CNPJ do emitente',
      [{ field: 'pfx', message: 'Não é um e-CNPJ' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  writeSecret(issuerSecretRef(schemaName, institutionId, ISSUER_SECRET_NAMES.cert), certPem)
  writeSecret(issuerSecretRef(schemaName, institutionId, ISSUER_SECRET_NAMES.key), keyPem)
  return issuerCertificateStatus(schemaName, institutionId)
}

/** Apaga o par do estabelecimento (as linhas dos modelos ficam — e deixam de estar habilitadas). */
export function clearIssuerCertificate(schemaName: string, institutionId: number): IssuerCertificateStatus {
  for (const name of Object.values(ISSUER_SECRET_NAMES)) {
    deleteSecret(issuerSecretRef(schemaName, institutionId, name))
  }
  return issuerCertificateStatus(schemaName, institutionId)
}
