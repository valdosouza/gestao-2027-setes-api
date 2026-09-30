/// <reference types="jest" />
// Gate ADVERSARIAL (2026-09-29) — A8: nota com registro fiscal cancelada FICA viva (D3/D4) e
// continua exibindo XML/DANFSe. ACHADO MEDIUM: o DANFSe é renderizado do XML da NFS-e gravado em
// disco na AUTORIZAÇÃO; a situação "cancelada" vem dos EVENTOS da chave (adn.ts queryNfse —
// GET /nfse/{chave}/eventos), nunca é embutida nesse XML, e ninguém regrava o arquivo no
// cancelamento. Resultado: o DANFSe de uma NFS-e cancelada sai SEM o selo "NFS-e CANCELADA"
// (danfse.ts só carimba quando o XML tem <e101101>). A voz C já está gravada na transmissão
// vigente — o selo tem de sair dela, não do arquivo.
import fs from 'fs'
import { inflateSync } from 'zlib'
import pool from '../shared/db/connection'
import { fiscalDanfse } from '../modules/billing/billing.fiscal.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/entity', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/entity'),
  getEntityFiscalFull: jest.fn().mockResolvedValue({
    entity: { nameCompany: 'SETES SISTEMAS LTDA' }, company: { cnpj: '12345678000199' },
    addresses: [{ main: 'S', cityName: 'Curitiba', stateName: 'PR' }],
  }),
}))
jest.mock('../shared/invoice-transmission/branches/service', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/invoice-transmission/branches/service'),
  emitterCnpj: jest.fn().mockResolvedValue('12345678000199'),
  findFiscalXml: jest.fn().mockReturnValue('C:/fake/NFSe.xml'),
}))

const KEY = '41069021212345678000199000000000012320260921000012345'.slice(0, 50)
/** XML da NFS-e como o ADN devolve na AUTORIZAÇÃO (sem evento de cancelamento embutido). */
const AUTHORIZED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">
<xLocEmi>Curitiba</xLocEmi><nNFSe>123</nNFSe><cStat>100</cStat><dhProc>2026-09-21T10:15:30-03:00</dhProc>
<emit><CNPJ>12345678000199</CNPJ><IM>777</IM><xNome>SETES SISTEMAS LTDA</xNome></emit>
<valores><vLiq>100.00</vLiq><vISSQN>2.00</vISSQN><pAliqAplic>2.00</pAliqAplic></valores>
<DPS><infDPS Id="DPS4106902212345678000199000010000000000000042"><tpAmb>2</tpAmb><serie>1</serie><nDPS>42</nDPS><dCompet>2026-09-21</dCompet>
<prest><CNPJ>12345678000199</CNPJ><IM>777</IM></prest>
<toma><CNPJ>98765432000188</CNPJ><xNome>Cliente</xNome></toma>
<serv><locPrest><cLocPrestacao>4106902</cLocPrestacao></locPrest><cServ><cTribNac>010201</cTribNac><xDescServ>Licenca</xDescServ></cServ></serv>
<valores><vServPrest><vServ>100.00</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq></tribMun></trib></valores>
</infDPS></DPS></infNFSe></NFSe>`

function pdfText(pdf: Buffer): string {
  const out: string[] = []
  const src = pdf.toString('latin1')
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const start = m.index + m[0].indexOf(m[1])
    const raw = pdf.subarray(start, start + Buffer.byteLength(m[1], 'latin1'))
    try { out.push(inflateSync(raw).toString('latin1')) } catch { out.push(m[1]) }
  }
  return out.join('\n').replace(/\[((?:<[0-9a-fA-F]*>|[\s\-\d.])+)\]\s*TJ/g, (_, arr: string) =>
    (arr.match(/<([0-9a-fA-F]*)>/g) ?? []).map(h => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join(''))
}

/** Linha do TX_SELECT: vigente detém a chave e o último evento é a voz C do fisco. */
const cancelledTx = {
  institutionId: 1, invoiceId: 10, attempt: 1, environment: 'H', dpsId: 'DPS4106902212345678000199000010000000000000042',
  accessKey: KEY, nfseNumber: '123', invoiceEvent: 1, dhProc: '2026-09-21 10:15:30', createdAt: '2026-09-21 10:15:00',
  ageMinutes: 9999, lastQueriedAt: null, lastEvent: 3, lastKind: 'C', lastCode: null,
  lastMessage: 'Cancelada no fisco: erro na emissão', lastDh: '2026-09-29 09:00:00', lastEventAt: '2026-09-29 09:00:00',
  lastEventAgeMinutes: 10,
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(pool as any).query.mockResolvedValue([[cancelledTx]])
  jest.spyOn(fs, 'readFileSync').mockReturnValue(AUTHORIZED_XML as any)
})
afterEach(() => jest.restoreAllMocks())

describe('A8 (MEDIUM) — DANFSe de NFS-e cancelada (nota viva com evento C)', () => {
  it('a vigente tem voz C → o PDF sai com o selo "NFS-e CANCELADA" mesmo com o XML da autorização em disco', async () => {
    const r = await fiscalDanfse({ institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' } as any, 10)
    expect(r.accessKey).toBe(KEY)
    expect(pdfText(Buffer.from(r.pdfBase64, 'base64'))).toContain('CANCELADA')
  })
})
