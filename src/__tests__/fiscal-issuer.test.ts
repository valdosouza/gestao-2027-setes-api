/// <reference types="jest" />
// Onda 3 (NFS-e / NF-e) — conceito A: HABILITAÇÃO DO EMISSOR FISCAL (D-N4/D-N5/D-N6, D-E1/D-E4).
// O que estes testes fixam: o .pfx + senha viram par PEM no cofre do AMBIENTE (senha nunca
// persistida); senha errada/vencido NÃO gravam (cofre = último par válido); CNPJ é lido do CN
// do e-CNPJ; openIssuer falha na ORDEM (linha → par → validade); "habilitado" é derivado;
// mudar o ambiente com transmissão viva é recusado; 65 ainda não existe.
import fs from 'fs'
import os from 'os'
import path from 'path'
import forge from 'node-forge'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-fiscal-issuer-'))
process.env.SECRETS_PATH = root

import pool from '../shared/db/connection'
import {
  storeIssuerCertificate, clearIssuerCertificate, issuerCertificateStatus, openIssuer, isIssuerEnabled,
  issuerSecretRef, ISSUER_SECRET_NAMES, ISSUER_SECRET_ENVIRONMENT, authorityOf, cnpjFromSubject, pkcs12ToPem,
  FINAL_TRANSMISSION_KINDS,
} from '../shared/fiscal-issuer'
import { hasSecret, readSecret, looksLikeCertificatePem, looksLikePrivateKeyPem, keyMatchesCertificate } from '../shared/secret-store'
import { fetchIssuerView, saveIssuer, removeIssuer, saveIssuerCertificate } from '../modules/establishment/establishment.issuer.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); delete process.env.SECRETS_PATH })

// ---------------------------------------------------------------------------
// PKCS#12 REAL gerado no teste (node-forge): par RSA 2048 + certificado autoassinado
// com CN no padrão ICP-Brasil ("RAZAO SOCIAL:CNPJ") + uma AC "isca" na cadeia.
// ---------------------------------------------------------------------------
const CNPJ = '12345678000199'
const PASSWORD = 'senha-do-pfx'
const S = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }

function selfSigned(keys: forge.pki.rsa.KeyPair, cn: string, notAfter: Date, notBefore = new Date(Date.now() - 86_400_000)) {
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = String(Date.now())
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }, { name: 'organizationName', value: 'ICP-Brasil' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return cert
}

function toPfx(key: forge.pki.rsa.PrivateKey, certs: forge.pki.Certificate[], password: string): Buffer {
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, certs, password, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary')
}

let leafKeys: forge.pki.rsa.KeyPair
let caKeys: forge.pki.rsa.KeyPair
let validPfx: Buffer
let expiredPfx: Buffer

beforeAll(() => {
  leafKeys = forge.pki.rsa.generateKeyPair(2048)
  caKeys = forge.pki.rsa.generateKeyPair(1024)          // isca: só para provar que a cadeia é ignorada
  const oneYear = new Date(Date.now() + 365 * 86_400_000)
  const leaf = selfSigned(leafKeys, `EMPRESA TESTE:${CNPJ}`, oneYear)
  const ca = selfSigned(caKeys, 'AC ISCA', oneYear)
  validPfx = toPfx(leafKeys.privateKey, [ca, leaf], PASSWORD)   // AC ANTES da folha de propósito
  const expired = selfSigned(leafKeys, `EMPRESA VENCIDA:${CNPJ}`, new Date(Date.now() - 86_400_000), new Date(Date.now() - 2 * 86_400_000))
  expiredPfx = toPfx(leafKeys.privateKey, [expired], PASSWORD)
}, 60_000)

beforeEach(() => {
  jest.clearAllMocks()
  conn.query.mockResolvedValue([{}])
  q.mockResolvedValue([[]])
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
})

const certRef = (_env?: 'H' | 'P') => issuerSecretRef(S.schemaName, S.institutionId, ISSUER_SECRET_NAMES.cert)   // D-N31: um cofre só
const keyRef  = (_env?: 'H' | 'P') => issuerSecretRef(S.schemaName, S.institutionId, ISSUER_SECRET_NAMES.key)

describe('peça — derivações', () => {
  it('autoridade é FUNÇÃO do modelo (SE → ADN; 55/65 → SEFAZ) e H e P partilham o MESMO cofre (D-N31)', () => {
    expect(authorityOf('SE')).toBe('ADN'); expect(authorityOf('55')).toBe('SEFAZ'); expect(authorityOf('65')).toBe('SEFAZ')
    expect(ISSUER_SECRET_ENVIRONMENT).toBe('P'); expect(certRef('H')).toEqual(certRef('P'))   // D-N31: H e P partilham o par
    expect(certRef('H')).toEqual({ schemaName: 'setes_setes', owner: 'establishment', ownerId: 1, environment: 'P', name: 'certificate.pem' })
    expect(keyRef('P').environment).toBe('P')
  })

  it('CNPJ do CN no padrão ICP-Brasil; CN sem o padrão → null', () => {
    expect(cnpjFromSubject('CN=EMPRESA TESTE:12345678000199, C=BR')).toBe('12345678000199')
    expect(cnpjFromSubject('C=BR, O=X, CN=FULANO DA SILVA:12345678901')).toBeNull()
    expect(cnpjFromSubject('CN=sem cnpj')).toBeNull()
  })

  it('vozes finais da transmissão = A/R/C/F/N (S e K deixam viva — N é a D-N17)', () => {
    expect([...FINAL_TRANSMISSION_KINDS].sort()).toEqual(['A', 'C', 'F', 'N', 'R'])
  })
})

describe('upload do A1 — PKCS#12 → par PEM no cofre do estabelecimento (um só — D-N31)', () => {
  it('senha ERRADA → 400 FISCAL_CERT_INVALID no campo pfx e NADA gravado', () => {
    expect(() => storeIssuerCertificate(S.schemaName, S.institutionId, validPfx, 'errada'))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'FISCAL_CERT_INVALID', fields: [expect.objectContaining({ field: 'pfx' })] }))
    expect(hasSecret(certRef('H'))).toBe(false); expect(hasSecret(keyRef('H'))).toBe(false)
  })

  it('arquivo que não é PKCS#12 → 400 FISCAL_CERT_INVALID', () => {
    expect(() => pkcs12ToPem(Buffer.from('isto nao e um pfx'), PASSWORD)).toThrow(expect.objectContaining({ statusCode: 400, code: 'FISCAL_CERT_INVALID' }))
    expect(() => storeIssuerCertificate(S.schemaName, S.institutionId, Buffer.from('x'), PASSWORD)).toThrow(expect.objectContaining({ code: 'FISCAL_CERT_INVALID' }))
    expect(hasSecret(certRef('H'))).toBe(false)
  })

  it('VENCIDO → 409 FISCAL_CERT_EXPIRED sem gravar', () => {
    expect(() => storeIssuerCertificate(S.schemaName, S.institutionId, expiredPfx, PASSWORD))
      .toThrow(expect.objectContaining({ statusCode: 409, code: 'FISCAL_CERT_EXPIRED' }))
    expect(hasSecret(certRef('H'))).toBe(false); expect(hasSecret(keyRef('H'))).toBe(false)
  })

  it('senha certa → certificado FOLHA (não a AC da cadeia) + chave em PEM, par coerente, status com CNPJ', () => {
    const status = storeIssuerCertificate(S.schemaName, S.institutionId, validPfx, PASSWORD)
    expect(status.certificate).toBe(true); expect(status.privateKey).toBe(true)
    expect(status.certificateInfo).toEqual(expect.objectContaining({ cnpj: CNPJ, expired: false }))
    expect(status.certificateInfo!.subject).toContain(`EMPRESA TESTE:${CNPJ}`)
    expect(status.certificateInfo!.daysToExpire).toBeGreaterThan(300)
    const certPem = readSecret(certRef('H')).toString()
    const keyPem = readSecret(keyRef('H')).toString()
    expect(looksLikeCertificatePem(certPem)).toBe(true); expect(looksLikePrivateKeyPem(keyPem)).toBe(true)
    expect(keyMatchesCertificate(certPem, keyPem)).toBe(true)
    // a folha é a que casa com a chave: a AC isca nunca vai para o cofre
    expect(certPem).not.toContain('AC ISCA')
    expect(certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1)
    // a senha não está em lugar nenhum do cofre
    for (const f of fs.readdirSync(path.dirname(path.join(root, 'setes_setes', 'establishment', '1', 'P', 'x')))) {
      expect(fs.readFileSync(path.join(root, 'setes_setes', 'establishment', '1', 'P', f)).toString()).not.toContain(PASSWORD)
    }
    // D-N31: o par é do ESTABELECIMENTO — presente para H e P
    expect(issuerCertificateStatus(S.schemaName, S.institutionId)).toMatchObject({ certificate: true, privateKey: true })
  })

  it('invariante "cofre = último par válido": upload vencido/errado por cima do válido não toca o par existente', () => {
    const before = readSecret(certRef('H')).toString()
    expect(() => storeIssuerCertificate(S.schemaName, S.institutionId, expiredPfx, PASSWORD)).toThrow(expect.objectContaining({ code: 'FISCAL_CERT_EXPIRED' }))
    expect(() => storeIssuerCertificate(S.schemaName, S.institutionId, validPfx, 'errada')).toThrow(expect.objectContaining({ code: 'FISCAL_CERT_INVALID' }))
    expect(readSecret(certRef('H')).toString()).toBe(before)
    expect(isIssuerEnabled(issuerCertificateStatus(S.schemaName, S.institutionId))).toBe(true)
  })

  it('service: base64 inválido → 400 FISCAL_CERT_INVALID antes de abrir; válido devolve o status do ÚNICO certificado (D-N31)', async () => {
    await expect(saveIssuerCertificate({ pfxBase64: '###', password: PASSWORD }, S)).rejects.toMatchObject({ statusCode: 400, code: 'FISCAL_CERT_INVALID' })
    const view = await saveIssuerCertificate({ pfxBase64: validPfx.toString('base64'), password: PASSWORD }, S)
    expect(view).toEqual(expect.objectContaining({ certificate: true, privateKey: true }))
    expect(view.certificateInfo!.cnpj).toBe(CNPJ)
    expect(clearIssuerCertificate(S.schemaName, S.institutionId)).toEqual({ certificate: false, privateKey: false, certificateInfo: null })
  })
})

describe('openIssuer — 409s na ORDEM: linha → par no cofre do estabelecimento → validade', () => {
  beforeEach(() => { storeIssuerCertificate(S.schemaName, S.institutionId, validPfx, PASSWORD) })

  it('sem linha → FISCAL_ISSUER_MISSING (antes de olhar o cofre)', async () => {
    q.mockResolvedValue([[]])
    await expect(openIssuer(S.schemaName, S.institutionId, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_MISSING' })
  })

  it('cofre vazio → FISCAL_CERT_MISSING; linha em P abre com o ÚNICO A1 do estabelecimento (D-N31: o mesmo par serve a H e a P)', async () => {
    q.mockResolvedValue([[{ institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: 7 }]])
    clearIssuerCertificate(S.schemaName, S.institutionId)
    await expect(openIssuer(S.schemaName, S.institutionId, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CERT_MISSING' })
    storeIssuerCertificate(S.schemaName, S.institutionId, validPfx, PASSWORD)
    const opened = await openIssuer(S.schemaName, S.institutionId, 'SE')
    expect(opened.issuer.environment).toBe('P'); expect(opened.info.cnpj).toBe(CNPJ)
  })

  it('linha em H com par válido em H → abre com cert/key e info (CNPJ); FOR UPDATE quando pedido', async () => {
    conn.query.mockResolvedValue([[{ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: 7 }]])
    const opened = await openIssuer(S.schemaName, S.institutionId, 'SE', { conn: conn as any, forUpdate: true })
    expect(q).not.toHaveBeenCalled()   // dentro da transação lê pela CONEXÃO, nunca pelo pool
    expect(opened.issuer).toEqual({ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: 7 })
    expect(Buffer.isBuffer(opened.cert) && Buffer.isBuffer(opened.key)).toBe(true)
    expect(opened.info.cnpj).toBe(CNPJ)
    expect(conn.query.mock.calls[0][0]).toContain('FOR UPDATE')
  })

  it('certificado vencido no cofre → FISCAL_CERT_EXPIRED', async () => {
    // grava direto um vencido em P (a peça de upload nunca deixaria — simula o tempo passando)
    const { certPem, keyPem } = pkcs12ToPem(expiredPfx, PASSWORD)
    const { writeSecret } = jest.requireActual('../shared/secret-store')
    writeSecret(certRef('P'), certPem); writeSecret(keyRef('P'), keyPem)
    q.mockResolvedValue([[{ institutionId: 1, model: '55', environment: 'P', serie: '1', userId: null }]])
    await expect(openIssuer(S.schemaName, S.institutionId, '55')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CERT_EXPIRED' })
    clearIssuerCertificate(S.schemaName, S.institutionId)
  })
})

describe('GET — enabled DERIVADO por linha (linha × cofre único do estabelecimento)', () => {
  beforeEach(() => { storeIssuerCertificate(S.schemaName, S.institutionId, validPfx, PASSWORD) })
  it('SE em H (par válido) habilitado; 55 em P (cofre vazio) não; autoridade por modelo', async () => {
    q.mockResolvedValue([[
      { institutionId: 1, model: '55', environment: 'P', serie: '1', userId: null },
      { institutionId: 1, model: 'SE', environment: 'H', serie: '12', userId: 7 },
    ]])
    const view = await fetchIssuerView(S)
    // D-N31: o MESMO A1 habilita os dois modelos, em qualquer ambiente
    expect(view.issuers).toEqual([
      { model: '55', environment: 'P', serie: '1', enabled: true, authority: 'SEFAZ' },
      { model: 'SE', environment: 'H', serie: '12', enabled: true, authority: 'ADN' },
    ])
    expect(view.certificate.certificate).toBe(true)
    expect(view.certificate.certificateInfo!.cnpj).toBe(CNPJ)
  })
})

describe('PUT /issuer/:model', () => {
  const issuerSql = (sql: string) => /tb_establishment_issuer/.test(sql) && /SELECT/.test(sql)
  const countSql = (sql: string) => /tb_invoice_service_transmission/.test(sql)
  const insertSql = (sql: string) => /INSERT INTO/.test(sql)

  it('65 → 422 FISCAL_MODEL_NOT_SUPPORTED sem abrir transação', async () => {
    await expect(saveIssuer('65', { environment: 'H', serie: '1' }, S)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_MODEL_NOT_SUPPORTED' })
    await expect(removeIssuer('65', S)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_MODEL_NOT_SUPPORTED' })
    expect((pool as any).getConnection).not.toHaveBeenCalled()
  })

  it('SE: série fora de 1–49999 → 422 no campo serie; "00012" grava "12"', async () => {
    await expect(saveIssuer('SE', { environment: 'H', serie: '50000' }, S)).rejects.toMatchObject({ statusCode: 422, fields: [expect.objectContaining({ field: 'serie' })] })
    await expect(saveIssuer('SE', { environment: 'H', serie: '0' }, S)).rejects.toMatchObject({ statusCode: 422 })
    conn.query.mockImplementation(async (sql: string) => {
      if (insertSql(sql)) return [{}]
      if (issuerSql(sql)) return [[{ institutionId: 1, model: 'SE', environment: 'H', serie: '12', userId: 7 }]]
      return [[]]
    })
    await saveIssuer('SE', { environment: 'H', serie: '00012' }, S)
    const insert = conn.query.mock.calls.find(c => insertSql(c[0]))!
    expect(insert[1]).toEqual([1, 'SE', 'H', '12', 7])
    expect(insert[0].replace(/\s+/g, ' ')).toContain("deleted = 'N', updated_at = NOW()")   // revive
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it('mudar o AMBIENTE (H → P) com transmissão VIVA em H → 409 FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS no campo environment, sem upsert, rollback', async () => {
    conn.query.mockImplementation(async (sql: string) => {
      if (issuerSql(sql)) return [[{ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: 7 }]]
      if (countSql(sql)) return [[{ n: 2 }]]
      return [{}]
    })
    await expect(saveIssuer('SE', { environment: 'P', serie: '1' }, S)).rejects.toMatchObject({
      statusCode: 409, code: 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS', fields: [expect.objectContaining({ field: 'environment' })],
    })
    // linha lida FOR UPDATE; contagem filtrada pelo ambiente ATUAL (H) e pelas vozes finais
    const sel = conn.query.mock.calls.find(c => issuerSql(c[0]))!
    expect(sel[0]).toContain('FOR UPDATE')
    const cnt = conn.query.mock.calls.find(c => countSql(c[0]))!
    expect(cnt[1]).toEqual([1, 'H', 'H'])
    expect(cnt[0].replace(/\s+/g, ' ')).toContain("le.kind IS NULL OR le.kind NOT IN ('A','R','C','F','N')")
    expect(conn.query.mock.calls.some(c => insertSql(c[0]))).toBe(false)
    expect(conn.rollback).toHaveBeenCalledTimes(1); expect(conn.commit).not.toHaveBeenCalled()
  })

  it('mesmo ambiente (H → H) não conta; H → P sem viva salva', async () => {
    conn.query.mockImplementation(async (sql: string) => {
      if (issuerSql(sql)) return [[{ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: 7 }]]
      if (countSql(sql)) return [[{ n: 0 }]]
      return [{}]
    })
    await saveIssuer('SE', { environment: 'H', serie: '1' }, S)
    expect(conn.query.mock.calls.some(c => countSql(c[0]))).toBe(false)
    jest.clearAllMocks()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    await saveIssuer('SE', { environment: 'P', serie: '1' }, S)
    expect(conn.query.mock.calls.some(c => countSql(c[0]))).toBe(true)
    expect(conn.query.mock.calls.some(c => insertSql(c[0]))).toBe(true)
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it('55 muda de ambiente SEM contar (ainda não transmite)', async () => {
    conn.query.mockImplementation(async (sql: string) => {
      if (issuerSql(sql)) return [[{ institutionId: 1, model: '55', environment: 'H', serie: '1', userId: 7 }]]
      return [{}]
    })
    await saveIssuer('55', { environment: 'P', serie: '3' }, S)
    expect(conn.query.mock.calls.some(c => countSql(c[0]))).toBe(false)
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it('DELETE: viva em QUALQUER ambiente prende (409); sem viva soft-deleta e o certificado do estabelecimento FICA', async () => {
    storeIssuerCertificate(S.schemaName, S.institutionId, validPfx, PASSWORD)
    conn.query.mockImplementation(async (sql: string) => {
      if (issuerSql(sql)) return [[{ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: 7 }]]
      if (countSql(sql)) return [[{ n: 1 }]]
      return [{ affectedRows: 1 }]
    })
    await expect(removeIssuer('SE', S)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS' })
    const cnt = conn.query.mock.calls.find(c => countSql(c[0]))!
    expect(cnt[1]).toEqual([1, null, null])
    expect(conn.rollback).toHaveBeenCalled()
    jest.clearAllMocks()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockImplementation(async (sql: string) => {
      if (issuerSql(sql)) return [[{ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: 7 }]]
      if (countSql(sql)) return [[{ n: 0 }]]
      return [{ affectedRows: 1 }]
    })
    await removeIssuer('SE', S)
    expect(conn.query.mock.calls.some(c => /SET deleted = 'S'/.test(c[0]))).toBe(true)
    expect(conn.commit).toHaveBeenCalledTimes(1)
    expect(hasSecret(certRef('H'))).toBe(true); expect(hasSecret(keyRef('H'))).toBe(true)
  })

  it('DELETE de linha inexistente → 404 FISCAL_ISSUER_MISSING', async () => {
    conn.query.mockResolvedValue([[]])
    await expect(removeIssuer('55', S)).rejects.toMatchObject({ statusCode: 404, code: 'FISCAL_ISSUER_MISSING' })
  })
})
