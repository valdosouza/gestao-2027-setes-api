/// <reference types="jest" />
// Gate ADVERSARIAL (2026-09-30) — delta Q-CA5 (registro fiscal só com chave de PRODUÇÃO) +
// Q-N38 (XML do evento de cancelamento em disco) + contestação do fechamento da Q-ADV1
// ("todo F é conclusivo").
//
// ACHADO MEDIUM (Q-ADV1, confirmado por caracterização): a classificação "credencial recusada"
// da fronteira HTTPS é feita pelo TEXTO do erro, não pela FASE da conexão. Um erro de camada de
// registro TLS depois do handshake (OpenSSL 3: "SSL routines::decryption failed or bad record
// mac" — pode ocorrer já com o corpo do POST entregue, lendo a resposta) vira 409
// FISCAL_AUTHORITY_AUTH_FAILED → classifyAuthorityError 'auth_failed' → OUTCOME_KIND 'F'.
// F fecha a tentativa, libera o cancelamento LOCAL (caminho da pendente: nota soft-deletada,
// número liberado) e não entra na consulta ativa — se o fisco processou, a NFS-e fica órfã.
// Este teste FIXA o comportamento atual; se o Valdo decidir que erro pós-handshake é ambíguo,
// o expect inverte para 'ambiguous'.
import fs from 'fs'
import os from 'os'
import path from 'path'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

import { authorityJson, transport } from '../shared/tax-authority/https-json'
import {
  classifyAuthorityError, OUTCOME_KIND, cancelEventFileName, saveFiscalXml, findFiscalXml, nfseFileName,
} from '../shared/invoice-transmission/branches/service'

const KEY = '41069022112345678000199000000000000042609300000001'   // 50 dígitos

describe('Q-ADV1 — F por "credencial" é decidido pelo texto do erro, não pela fase', () => {
  const original = transport.request
  afterEach(() => { transport.request = original })

  it('erro TLS de camada de registro (pós-handshake) fecha a tentativa com F [ACHADO MEDIUM — caracterização]', async () => {
    transport.request = jest.fn().mockRejectedValue(Object.assign(
      new Error('error:0A000119:SSL routines::decryption failed or bad record mac'),
      { code: 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC' },
    )) as any
    let caught: unknown
    try {
      await authorityJson({ url: 'https://sefin.example/nfse', method: 'POST', body: '{}' }, 'nfse')
    } catch (err) { caught = err }
    expect(caught).toMatchObject({ code: 'FISCAL_AUTHORITY_AUTH_FAILED' })
    const cls = classifyAuthorityError(caught)
    expect(cls).toBe('auth_failed')
    expect(OUTCOME_KIND[cls as 'auth_failed']).toBe('F')
  })

  it('queda de socket sem texto TLS continua AMBÍGUA (controle)', async () => {
    transport.request = jest.fn().mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })) as any
    let caught: unknown
    try {
      await authorityJson({ url: 'https://sefin.example/nfse', method: 'POST', body: '{}' }, 'nfse')
    } catch (err) { caught = err }
    expect(classifyAuthorityError(caught)).toBe('ambiguous')
  })
})

describe('Q-N38 — arquivo do evento de cancelamento em disco', () => {
  let root: string
  const prev = process.env.STORAGE_PATH
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qn38-'))
    process.env.STORAGE_PATH = root
  })
  afterEach(() => {
    process.env.STORAGE_PATH = prev
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('nome derivado só dos dígitos da chave — chave com traversal não sai da pasta do CNPJ', () => {
    const name = cancelEventFileName('../../etc/' + KEY)
    expect(name).toBe(`${KEY}-evt101101.xml`)
    const full = saveFiscalXml('12345678000199', name, '<evento/>', new Date(2026, 8, 15))
    expect(full.startsWith(path.join(root, '12345678000199', '2026', '09'))).toBe(true)
  })

  it('nome com separador é recusado pelo saveFiscalXml (defesa da peça)', () => {
    expect(() => saveFiscalXml('12345678000199', '../x-evt101101.xml', '<e/>')).toThrow(/inválido/)
  })

  it('evento gravado no mês da AUTORIZAÇÃO é achado pela consulta pelo mesmo nome (sem duplicar)', () => {
    saveFiscalXml('12345678000199', cancelEventFileName(KEY), '<evento/>', new Date('2026-08-31T23:59:00'))
    expect(findFiscalXml('12345678000199', cancelEventFileName(KEY), ['2026-08-31 23:59:00'])).toContain(path.join('2026', '08'))
  })

  it('NFS-e descoberta pela consulta (dhProc ainda nulo) e evento gravado depois ficam em pastas DIFERENTES [LOW]', () => {
    // refresh: `when = target.dhProc ? … : new Date()` — a NFS-e cai no mês de HOJE; o evento, no do dhProc
    saveFiscalXml('12345678000199', nfseFileName(KEY), '<nfse/>', new Date('2026-10-02T10:00:00'))
    saveFiscalXml('12345678000199', cancelEventFileName(KEY), '<evento/>', new Date('2026-09-30T18:00:00'))
    const nfse = findFiscalXml('12345678000199', nfseFileName(KEY))!
    const evt = findFiscalXml('12345678000199', cancelEventFileName(KEY))!
    expect(path.dirname(nfse)).not.toBe(path.dirname(evt))   // achável (varredura), mas não "ao lado"
  })
})
