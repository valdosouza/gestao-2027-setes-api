import { SignedXml } from 'xml-crypto'

/**
 * Assinatura XMLDSig ENVELOPED no padrão do Sistema Nacional NFS-e (Manual
 * Integrado 2022 §6.1.4): Reference `#Id` do elemento assinado, transforms
 * enveloped-signature + C14N inclusiva, canonicalização C14N inclusiva,
 * KeyInfo só com X509Certificate do certificado FINAL (EndCertOnly), sem
 * KeyValue/SubjectName. A Signature entra como ÚLTIMO filho do PAI do elemento
 * assinado (DPS/infDPS → DPS; pedRegEvento/infPedReg → pedRegEvento).
 *
 * Algoritmo parametrizado: o manual de 2022 fixa rsa-sha1/sha1 e é o que o ADN
 * aceita hoje (padrão); sha256 fica pronto para quando o fisco virar — o
 * adaptador escolhe (D-N12: a 1ª sessão com o e-CNPJ confirma).
 */

export type SignAlgorithm = 'sha1' | 'sha256'

export const C14N_INCLUSIVE   = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
export const ENVELOPED        = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
export const DSIG_NS          = 'http://www.w3.org/2000/09/xmldsig#'

const ALGORITHMS: Record<SignAlgorithm, { signature: string; digest: string }> = {
  sha1:   { signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',          digest: 'http://www.w3.org/2000/09/xmldsig#sha1' },
  sha256: { signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',   digest: 'http://www.w3.org/2001/04/xmlenc#sha256' },
}

export interface SignXmlOptions {
  /** Valor do atributo Id do elemento a assinar (ex.: 'DPS4106902…'). */
  referenceId: string
  cert: Buffer            // PEM (pode trazer cadeia — só o 1º certificado entra no KeyInfo)
  key:  Buffer            // PEM
  algorithm: SignAlgorithm
}

/** Primeiro bloco CERTIFICATE do PEM (EndCertOnly — a cadeia fica de fora). */
export function firstCertificatePem(pem: Buffer | string): string {
  const m = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)
  if (!m) throw new Error('Certificado PEM sem bloco CERTIFICATE')
  return m[0]
}

function assertReferenceId(id: string): void {
  // vai dentro de um XPath com aspas simples; o Id do DPS/evento é alfanumérico por construção
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error(`Id de referência inválido para assinatura: ${id}`)
}

/**
 * Assina `xml` em volta do elemento cujo atributo `Id` = `referenceId` e devolve
 * o XML com a Signature já posicionada. Lança se o Id não existir no XML.
 */
export function signXml(xml: string, opts: SignXmlOptions): string {
  assertReferenceId(opts.referenceId)
  const alg = ALGORITHMS[opts.algorithm]
  const target = `//*[@Id='${opts.referenceId}']`
  const sig = new SignedXml({
    privateKey: opts.key,
    publicCert: firstCertificatePem(opts.cert),
    signatureAlgorithm: alg.signature,
    canonicalizationAlgorithm: C14N_INCLUSIVE,
  })
  // xml-crypto lê o Id existente do nó e escreve URI="#<Id>" — nunca inventa um id
  sig.addReference({ xpath: target, transforms: [ENVELOPED, C14N_INCLUSIVE], digestAlgorithm: alg.digest, uri: `#${opts.referenceId}` })
  // location = PAI do elemento assinado, append → Signature vira o último filho dele
  sig.computeSignature(xml, { location: { reference: `${target}/..`, action: 'append' } })
  return sig.getSignedXml()
}

/**
 * Verifica a assinatura enveloped de `signedXml` com o certificado dado (PEM).
 * Só a chave passada conta: o X509Certificate do KeyInfo é ignorado (quem
 * verifica escolhe em quem confia). Nunca lança — false para qualquer falha.
 */
export function verifyXml(signedXml: string, certPem: Buffer | string): boolean {
  try {
    const m = signedXml.match(/<Signature[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#"[^>]*>[\s\S]*?<\/Signature>/)
    if (!m) return false
    const v = new SignedXml({ publicCert: firstCertificatePem(certPem) })
    v.loadSignature(m[0])
    return v.checkSignature(signedXml) === true
  } catch {
    return false
  }
}
