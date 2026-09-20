/// <reference types="jest" />
// Onda 2 (D-I1/D-I3): segredos por DONO + FINALIDADE em arquivos fora do repo e
// fora do banco. O que estes testes fixam: caminho DERIVADO da identidade (sem
// coluna, sem `..`), leitura ausente vira 409 legível, certificado do canal e
// certificado fiscal nunca se misturam, e a validade é lida do PEM.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync, X509Certificate } from 'crypto'
import {
  secretFilePath, hasSecret, readSecret, writeSecret, deleteSecret,
  looksLikeCertificatePem, looksLikePrivateKeyPem, certificateInfo,
} from '../shared/secret-store'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-secrets-'))
beforeAll(() => { process.env.SECRETS_PATH = root })
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); delete process.env.SECRETS_PATH })

const ref = (over: Record<string, any> = {}) => ({
  schemaName: 'setes_setes', owner: 'bank-account' as const, ownerId: 1, environment: 'S' as const, name: 'client.crt', ...over,
})

describe('secret-store — caminho derivado da identidade', () => {
  it('<root>/<schema>/<owner>/<id>/<S|P>/<name>', () => {
    expect(secretFilePath(ref())).toBe(path.join(root, 'setes_setes', 'bank-account', '1', 'S', 'client.crt'))
    expect(secretFilePath(ref({ environment: 'P' }))).toBe(path.join(root, 'setes_setes', 'bank-account', '1', 'P', 'client.crt'))
  })

  it('D-I1: o certificado da CONTA (canal) e o do ESTABELECIMENTO (NFS-e) vivem em pastas diferentes — nunca se misturam', () => {
    const canal  = secretFilePath(ref())
    const fiscal = secretFilePath(ref({ owner: 'establishment', name: 'a1.pfx' }))
    expect(canal).not.toBe(fiscal)
    expect(fiscal).toContain(path.join('establishment', '1'))
  })

  it('componentes inválidos NÃO viram caminho (sem `..`, sem dono desconhecido, sem nome livre)', () => {
    expect(() => secretFilePath(ref({ name: '../../etc/passwd' }))).toThrow()
    expect(() => secretFilePath(ref({ name: 'a b' }))).toThrow()
    expect(() => secretFilePath(ref({ owner: 'carteira' }))).toThrow()
    expect(() => secretFilePath(ref({ ownerId: 0 }))).toThrow()
    expect(() => secretFilePath(ref({ environment: 'X' }))).toThrow()
    expect(() => secretFilePath(ref({ schemaName: 'setes_x; DROP' }))).toThrow()
  })
})

describe('secret-store — escrita/leitura', () => {
  it('ausente → hasSecret false e readSecret 409 com o código pedido (nunca 500)', () => {
    expect(hasSecret(ref({ name: 'client_secret' }))).toBe(false)
    expect(() => readSecret(ref({ name: 'client_secret' }), 'BANK_CHANNEL_SECRET_MISSING'))
      .toThrow(expect.objectContaining({ statusCode: 409, code: 'BANK_CHANNEL_SECRET_MISSING' }))
  })

  it('grava criando a árvore, lê de volta, apaga', () => {
    writeSecret(ref({ name: 'client_secret' }), 'shh')
    expect(hasSecret(ref({ name: 'client_secret' }))).toBe(true)
    expect(readSecret(ref({ name: 'client_secret' })).toString()).toBe('shh')
    expect(deleteSecret(ref({ name: 'client_secret' }))).toBe(true)
    expect(hasSecret(ref({ name: 'client_secret' }))).toBe(false)
  })

  it('reconhece a FORMA dos PEMs (upload write-only valida antes de gravar)', () => {
    expect(looksLikeCertificatePem('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----')).toBe(true)
    expect(looksLikeCertificatePem('-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----')).toBe(false)
    expect(looksLikePrivateKeyPem('-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----')).toBe(true)
    expect(looksLikePrivateKeyPem('-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----')).toBe(true)
    expect(looksLikePrivateKeyPem('segredo em texto')).toBe(false)
  })

  it('certificateInfo: PEM ilegível lança (o upload valida antes de gravar); validade é DERIVADA do arquivo', () => {
    // Node não emite X.509 nativamente; a leitura positiva é provada no smoke com o
    // certificado real do canal (scripts/smoke-inter-sandbox.ts), nunca com cópia no repo.
    expect(() => certificateInfo('-----BEGIN CERTIFICATE-----\nnada\n-----END CERTIFICATE-----')).toThrow()
    expect(() => new X509Certificate('not a cert')).toThrow()
  })
})
