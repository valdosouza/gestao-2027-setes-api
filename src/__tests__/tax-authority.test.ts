/// <reference types="jest" />
// Onda 3 — peça @shared/tax-authority (transporte fiscal; não conhece nota).
// O que se fixa aqui é o CONTRATO com o XSD v1.01 e o Manual 2022 §6.1.4:
// Id do DPS (45), ordem dos elementos do infDPS, escapador, assinatura
// enveloped (URI="#Id", transforms enveloped+C14N, X509Certificate) verificável
// e sensível a 1 char, pedido de evento e101101 (Id PRE+56), leitura da NFS-e e
// o adaptador ADN com transporte mockado (nenhum socket).
import crypto from 'crypto'
import forge from 'node-forge'
import { gunzipSync, gzipSync } from 'zlib'
import {
  buildDpsId, buildDpsXml, buildCancelEventXml, buildEventId, parseNfseXml, parseEventXml, escapeXml,
  formatDateTimeTz, signXml, verifyXml, adapterFor, DpsInput, AuthorityContext, C14N_INCLUSIVE, ENVELOPED,
} from '../shared/tax-authority'
import { transport } from '../shared/tax-authority/https-json'

// ---------------------------------------------------------------------------
// par RSA + certificado autoassinado (só para o teste — nada de e-CNPJ real)
// ---------------------------------------------------------------------------
function selfSigned(): { cert: Buffer; key: Buffer } {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
  const fk = forge.pki.privateKeyFromPem(keyPem)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.setRsaPublicKey(fk.n, fk.e)
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 86_400_000)
  const attrs = [{ name: 'commonName', value: 'SETES TESTE:12345678000199' }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(fk, forge.md.sha256.create())
  return { cert: Buffer.from(forge.pki.certificateToPem(cert)), key: Buffer.from(keyPem) }
}
const pair = selfSigned()
const other = selfSigned()

const dpsInput: DpsInput = {
  environment: 'H', dhEmi: '2026-09-21T10:15:30.123-03:00', verAplic: 'setes-api 1.0', serie: 1, nDps: 42, dCompet: '2026-09-21',
  tpEmit: '1', cLocEmi: '4106902',
  prest: { cnpj: '12345678000199', im: '123456', regTrib: { opSimpNac: '1', regEspTrib: '0' } },
  toma: {
    cnpj: '98765432000188', xNome: 'Cliente & Filhos <Ltda>',
    end: { cMun: '4106902', cep: '80010000', xLgr: 'Rua A', nro: '10', xCpl: 'Sala 2', xBairro: 'Centro' },
    fone: '4133331234', email: 'cliente@exemplo.com.br',
  },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Licença mensal <ERP> & suporte\nlinha 2' } },
  valores: { vServ: 1234.5, vDescIncond: 0, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1', pAliq: 2 }, totTrib: { indTotTrib: '0' } } },
}
const DPS_ID = buildDpsId('4106902', '2', '12345678000199', 1, 42)

/** Ordem de aparição de substrings no texto (a ordem do XSD importa). */
function inOrder(text: string, parts: string[]): void {
  let last = -1
  for (const p of parts) {
    const i = text.indexOf(p, last + 1)
    expect(i).toBeGreaterThan(last)
    last = i
  }
}

describe('buildDpsId / buildDpsXml', () => {
  it('Id = DPS + cMun(7) + tpInsc(1) + inscrição(14) + série(5) + nDPS(15) = 45 posições', () => {
    expect(DPS_ID).toBe('DPS' + '4106902' + '2' + '12345678000199' + '00001' + '000000000000042')
    expect(DPS_ID).toHaveLength(45)
    expect(buildDpsId('4106902', '1', '12345678901', 49999, 1)).toBe('DPS4106902' + '1' + '00012345678901' + '49999' + '000000000000001')
    expect(() => buildDpsId('410690', '2', '12345678000199', 1, 1)).toThrow(/cMun/)
    expect(() => buildDpsId('4106902', '2', '12345678000199', 0, 1)).toThrow(/série/)
  })

  it('XML segue a ORDEM do TCInfDPS/TCInfoPrestador/TCInfoPessoa/TCServ/TCInfoValores, sem formatação entre tags', () => {
    const xml = buildDpsXml(dpsInput, DPS_ID)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="' + DPS_ID + '">')).toBe(true)
    expect(xml.endsWith('</infDPS></DPS>')).toBe(true)
    expect(xml).not.toMatch(/>\s+</)
    inOrder(xml, [
      '<tpAmb>2</tpAmb>', '<dhEmi>2026-09-21T10:15:30-03:00</dhEmi>', '<verAplic>setes-api 1.0</verAplic>', '<serie>1</serie>', '<nDPS>42</nDPS>',
      '<dCompet>2026-09-21</dCompet>', '<tpEmit>1</tpEmit>', '<cLocEmi>4106902</cLocEmi>',
      '<prest><CNPJ>12345678000199</CNPJ><IM>123456</IM><regTrib><opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest>',
      '<toma><CNPJ>98765432000188</CNPJ><xNome>Cliente &amp; Filhos &lt;Ltda&gt;</xNome>',
      '<end><endNac><cMun>4106902</cMun><CEP>80010000</CEP></endNac><xLgr>Rua A</xLgr><nro>10</nro><xCpl>Sala 2</xCpl><xBairro>Centro</xBairro></end>',
      '<fone>4133331234</fone><email>cliente@exemplo.com.br</email></toma>',
      '<serv><locPrest><cLocPrestacao>4106902</cLocPrestacao></locPrest><cServ><cTribNac>010201</cTribNac><xDescServ>',
      '</xDescServ></cServ></serv>',
      '<valores><vServPrest><vServ>1234.50</vServ></vServPrest><vDescCondIncond><vDescIncond>0.00</vDescIncond></vDescCondIncond>',
      '<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq></tribMun><totTrib><indTotTrib>0</indTotTrib></totTrib></trib></valores>',
    ])
    // tpAmb deriva do ambiente; regApTribSN só entra se vier
    expect(buildDpsXml({ ...dpsInput, environment: 'P' }, DPS_ID)).toContain('<tpAmb>1</tpAmb>')
    expect(buildDpsXml({ ...dpsInput, prest: { ...dpsInput.prest, regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } } }, DPS_ID))
      .toContain('<regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib>')
  })

  it('xDescServ é escapado (&, <, >) e mantém a quebra de linha; tomador PF usa CPF; pTotTribSN é o outro ramo do choice', () => {
    const xml = buildDpsXml(dpsInput, DPS_ID)
    expect(xml).toContain('<xDescServ>Licença mensal &lt;ERP&gt; &amp; suporte\nlinha 2</xDescServ>')
    expect(xml).not.toContain('<ERP>')
    expect(escapeXml(`a"b'c`)).toBe('a&quot;b&apos;c')
    const pf = buildDpsXml({ ...dpsInput, toma: { cpf: '12345678901', xNome: 'Fulano' },
      valores: { ...dpsInput.valores, trib: { ...dpsInput.valores.trib, totTrib: { pTotTribSN: 6.5 } } } }, DPS_ID)
    expect(pf).toContain('<toma><CPF>12345678901</CPF><xNome>Fulano</xNome></toma>')
    expect(pf).toContain('<totTrib><pTotTribSN>6.50</pTotTribSN></totTrib>')
    expect(() => buildDpsXml({ ...dpsInput, toma: { cnpj: '98765432000188', cpf: '12345678901', xNome: 'x' } }, DPS_ID)).toThrow(/CNPJ ou CPF/)
    expect(() => buildDpsXml({ ...dpsInput, valores: { ...dpsInput.valores, trib: { ...dpsInput.valores.trib, tribMun: { tribISSQN: '1', tpRetISSQN: '1', pAliq: 10 } } } }, DPS_ID)).toThrow(/pAliq/)
  })

  it('dhEmi vira TSDateTimeUTC: sem milissegundos, Z → +00:00', () => {
    expect(formatDateTimeTz('2026-09-21T13:15:30.999Z')).toBe('2026-09-21T13:15:30+00:00')
    expect(formatDateTimeTz('2026-09-21T10:15:30-03:00')).toBe('2026-09-21T10:15:30-03:00')
    expect(formatDateTimeTz('2026-09-21T10:15:30-03:00')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:00$/)
  })
})

describe('signXml / verifyXml (XMLDSig enveloped, Manual 2022 §6.1.4)', () => {
  const xml = buildDpsXml(dpsInput, DPS_ID)

  it('sha1 (padrão do ADN): Reference URI="#Id", transforms enveloped → C14N, C14N inclusiva, rsa-sha1/sha1, X509Certificate só do certificado, Signature como último filho de <DPS>', () => {
    const signed = signXml(xml, { referenceId: DPS_ID, cert: pair.cert, key: pair.key, algorithm: 'sha1' })
    expect(signed).toContain(`<Reference URI="#${DPS_ID}">`)
    inOrder(signed, [
      '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">', '<SignedInfo>',
      `<CanonicalizationMethod Algorithm="${C14N_INCLUSIVE}"/>`,
      '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>',
      `<Reference URI="#${DPS_ID}">`, '<Transforms>', `<Transform Algorithm="${ENVELOPED}"/>`, `<Transform Algorithm="${C14N_INCLUSIVE}"/>`, '</Transforms>',
      '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>', '<DigestValue>', '</SignedInfo>', '<SignatureValue>',
      '<KeyInfo>', '<X509Data>', '<X509Certificate>', '</X509Certificate>', '</X509Data>', '</KeyInfo>', '</Signature>',
    ])
    // último filho do PAI do elemento assinado — nunca dentro do infDPS
    expect(signed).toMatch(/<\/infDPS><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">[\s\S]*<\/Signature><\/DPS>$/)
    expect(signed.indexOf('<Signature')).toBeGreaterThan(signed.indexOf('</infDPS>'))
    // certificado em base64 puro (sem cabeçalho PEM), SubjectName/KeyValue ausentes (manual 2022)
    const b64 = signed.match(/<X509Certificate>([^<]+)<\/X509Certificate>/)![1]
    expect(b64).not.toMatch(/BEGIN|\n/)
    expect(Buffer.from(b64, 'base64').length).toBeGreaterThan(300)
    expect(signed).not.toMatch(/X509SubjectName|KeyValue|X509IssuerSerial/)
    // sem prefixo ds: e a declaração XML preservada
    expect(signed).not.toContain('ds:')
    expect(signed.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(verifyXml(signed, pair.cert)).toBe(true)
  })

  it('alterar 1 caractere do conteúdo assinado invalida; outro certificado não verifica; XML sem assinatura = false', () => {
    const signed = signXml(xml, { referenceId: DPS_ID, cert: pair.cert, key: pair.key, algorithm: 'sha1' })
    const tampered = signed.replace('<vServ>1234.50</vServ>', '<vServ>1234.51</vServ>')
    expect(tampered).not.toBe(signed)
    expect(verifyXml(tampered, pair.cert)).toBe(false)
    expect(verifyXml(signed, other.cert)).toBe(false)
    expect(verifyXml(xml, pair.cert)).toBe(false)
  })

  it('sha256 parametrizado: rsa-sha256 + xmlenc#sha256, verificável', () => {
    const signed = signXml(xml, { referenceId: DPS_ID, cert: pair.cert, key: pair.key, algorithm: 'sha256' })
    expect(signed).toContain('<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>')
    expect(signed).toContain('<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>')
    expect(verifyXml(signed, pair.cert)).toBe(true)
  })

  it('Id inexistente no XML ou com caractere estranho → lança (nunca assina "nada")', () => {
    expect(() => signXml(xml, { referenceId: 'DPS' + '9'.repeat(42), cert: pair.cert, key: pair.key, algorithm: 'sha1' })).toThrow()
    expect(() => signXml(xml, { referenceId: "x'or", cert: pair.cert, key: pair.key, algorithm: 'sha1' })).toThrow(/Id de referência/)
  })

  it('pedido de evento assina infPedReg e a Signature fecha em </pedRegEvento>', () => {
    const chave = '4106902' + '2' + '2' + '12345678000199' + '0000000000123' + '2609' + '000000001' + '7'
    const ev = buildCancelEventXml({ accessKey: chave, dhEvento: '2026-09-21T11:00:00-03:00', cMotivo: '1', xMotivo: 'Erro na emissão: valor do serviço incorreto', environment: 'H', verAplic: 'setes-api 1.0', cnpjAutor: '12345678000199' })
    const id = buildEventId(chave, '101101')
    const signed = signXml(ev, { referenceId: id, cert: pair.cert, key: pair.key, algorithm: 'sha1' })
    expect(signed).toMatch(/<\/infPedReg><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">[\s\S]*<\/Signature><\/pedRegEvento>$/)
    expect(signed).toContain(`<Reference URI="#${id}">`)
    expect(verifyXml(signed, pair.cert)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// fixtures do fisco
// ---------------------------------------------------------------------------
const CHAVE = '4106902' + '2' + '2' + '12345678000199' + '0000000000123' + '2609' + '000000001' + '7'
const NFSE_XML = '<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infNFSe Id="NFS${CHAVE}"><xLocEmi>Curitiba</xLocEmi><xLocPrestacao>Curitiba</xLocPrestacao><nNFSe>123</nNFSe><cLocIncid>4106902</cLocIncid>`
  + '<xTribNac>Programação</xTribNac><verAplic>SNNFSE</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat><dhProc>2026-09-21T13:16:01-03:00</dhProc><nDFSe>555</nDFSe>'
  + '<emit><CNPJ>12345678000199</CNPJ><xNome>Setes</xNome><enderNac><xLgr>R</xLgr><nro>1</nro><xBairro>C</xBairro><cMun>4106902</cMun><UF>PR</UF><CEP>80010000</CEP></enderNac></emit>'
  + '<valores><vBC>1234.50</vBC><pAliqAplic>2.00</pAliqAplic><vISSQN>24.69</vISSQN><vLiq>1234.50</vLiq></valores>'
  + `<DPS versao="1.01"><infDPS Id="${DPS_ID}"><tpAmb>2</tpAmb><dhEmi>2026-09-21T10:15:30-03:00</dhEmi><nDPS>42</nDPS></infDPS></DPS></infNFSe>`
  + '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>x</SignatureValue></Signature></NFSe>'
const EVENT_XML = '<?xml version="1.0" encoding="UTF-8"?><evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infEvento Id="EVT${'0'.repeat(59)}"><verAplic>SNNFSE</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento><dhProc>2026-09-22T09:00:00-03:00</dhProc><nDFSe>556</nDFSe>`
  + `<pedRegEvento versao="1.01"><infPedReg Id="PRE${CHAVE}101101"><tpAmb>2</tpAmb><verAplic>setes-api 1.0</verAplic><dhEvento>2026-09-22T08:59:00-03:00</dhEvento><CNPJAutor>12345678000199</CNPJAutor><chNFSe>${CHAVE}</chNFSe>`
  + '<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Erro na emiss&#xE3;o: valor &amp; tomador</xMotivo></e101101></infPedReg></pedRegEvento></infEvento></evento>'

describe('buildCancelEventXml / parseNfseXml / parseEventXml', () => {
  it('pedRegEvento v1.01: Id = PRE + chave(50) + 101101 (59), ordem tpAmb/verAplic/dhEvento/CNPJAutor/chNFSe/e101101, xDesc fixo', () => {
    const xml = buildCancelEventXml({ accessKey: CHAVE, dhEvento: '2026-09-21T11:00:00.500-03:00', cMotivo: '2', xMotivo: 'Serviço não prestado ao <cliente>', environment: 'P', verAplic: 'setes-api 1.0', cnpjAutor: '12345678000199' })
    const id = `PRE${CHAVE}101101`
    expect(id).toHaveLength(59)
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
      + `<infPedReg Id="${id}"><tpAmb>1</tpAmb><verAplic>setes-api 1.0</verAplic><dhEvento>2026-09-21T11:00:00-03:00</dhEvento><CNPJAutor>12345678000199</CNPJAutor><chNFSe>${CHAVE}</chNFSe>`
      + '<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>2</cMotivo><xMotivo>Serviço não prestado ao &lt;cliente&gt;</xMotivo></e101101></infPedReg></pedRegEvento>')
    expect(buildCancelEventXml({ accessKey: CHAVE, dhEvento: '2026-09-21T11:00:00-03:00', cMotivo: '9', xMotivo: 'Outros motivos do cancelamento', environment: 'H', verAplic: 'v', cpfAutor: '12345678901' })).toContain('<CPFAutor>12345678901</CPFAutor>')
    expect(() => buildCancelEventXml({ accessKey: CHAVE, dhEvento: '2026-09-21T11:00:00-03:00', cMotivo: '1', xMotivo: 'curto', environment: 'H', verAplic: 'v', cnpjAutor: '12345678000199' })).toThrow(/15 a 255/)
    expect(() => buildCancelEventXml({ accessKey: '123', dhEvento: '2026-09-21T11:00:00-03:00', cMotivo: '1', xMotivo: 'Erro na emissão da nota fiscal', environment: 'H', verAplic: 'v', cnpjAutor: '12345678000199' })).toThrow(/chave/)
  })

  it('parseNfseXml lê a chave sem o literal NFS, número, dhProc, cStat e o Id do DPS embutido', () => {
    const p = parseNfseXml(NFSE_XML)
    expect(p).toMatchObject({ accessKey: CHAVE, nNFSe: '123', dhProc: '2026-09-21T13:16:01-03:00', cStat: '100', nDFSe: '555', ambGer: '2', dpsId: DPS_ID, cancelled: null })
  })

  it('parseEventXml lê ids, código, chave, datas e motivo (com entidades XML desfeitas)', () => {
    const e = parseEventXml(EVENT_XML)
    expect(e).toMatchObject({
      eventId: `EVT${'0'.repeat(59)}`, pedRegId: `PRE${CHAVE}101101`, eventCode: '101101', accessKey: CHAVE,
      dhEvento: '2026-09-22T08:59:00-03:00', dhProc: '2026-09-22T09:00:00-03:00', nSeqEvento: '1', cMotivo: '1', xMotivo: 'Erro na emissão: valor & tomador',
    })
  })
})

// ---------------------------------------------------------------------------
// adaptador ADN com transporte mockado — nenhum socket
// ---------------------------------------------------------------------------
const mockHttp = jest.fn()
transport.request = mockHttp as any
const ctx: AuthorityContext = { environment: 'H', cert: Buffer.from('cert-pem'), key: Buffer.from('key-pem') }
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : JSON.stringify(obj) })
const adn = adapterFor('ADN')

beforeEach(() => jest.clearAllMocks())

describe('adaptador ADN — transmit (POST /nfse)', () => {
  it('envia {dpsXmlGZipB64} = gzip+base64 do XML assinado, sob mTLS, no host da produção restrita; 201 devolve a NFS-e descomprimida', async () => {
    mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: CHAVE, nfseXmlGZipB64: gz(NFSE_XML), alertas: [] }, 201))
    const signed = signXml(buildDpsXml(dpsInput, DPS_ID), { referenceId: DPS_ID, cert: pair.cert, key: pair.key, algorithm: 'sha1' })
    const r = await adn.transmit(ctx, signed)
    expect(mockHttp).toHaveBeenCalledTimes(1)
    const call = mockHttp.mock.calls[0][0]
    expect(call.url).toBe('https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse')
    expect(call.method).toBe('POST')
    expect(call.headers['Content-Type']).toBe('application/json')
    expect(call.cert).toEqual(Buffer.from('cert-pem')); expect(call.key).toEqual(Buffer.from('key-pem'))
    const body = JSON.parse(call.body)
    expect(Object.keys(body)).toEqual(['dpsXmlGZipB64'])
    expect(gunzipSync(Buffer.from(body.dpsXmlGZipB64, 'base64')).toString('utf8')).toBe(signed)
    expect(r).toMatchObject({ accessKey: CHAVE, nfseNumber: '123', dhProc: '2026-09-21T13:16:01-03:00', nfseXml: NFSE_XML })
    expect((r.raw as any).alertas).toEqual([])
  })

  it('produção usa sefin.nfse.gov.br; sem chaveAcesso no JSON a chave sai do XML', async () => {
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: gz(NFSE_XML) }))
    // R2-2: a NFS-e devolvida embute o DPS — o Id tem que ser o ENVIADO (por isso o DPS mínimo leva o Id)
    const r = await adn.transmit({ ...ctx, environment: 'P' }, `<DPS><infDPS Id="${DPS_ID}"/></DPS>`)
    expect(mockHttp.mock.calls[0][0].url).toBe('https://sefin.nfse.gov.br/SefinNacional/nfse')
    expect(r.accessKey).toBe(CHAVE)
  })

  it('400 com erros[] → 422 FISCAL_DPS_REJECTED com os E0xxx em fields[] (field "dps")', async () => {
    mockHttp.mockResolvedValueOnce({ status: 400, headers: {}, text: JSON.stringify({ erros: [
      { codigo: 'E0718', descricao: 'A assinatura deve ser do emitente da DPS', complemento: 'CNPJ 12345678000199' },
      { codigo: 'E0006', descricao: 'Ambiente divergente' },
    ] }) })
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({
      statusCode: 422, code: 'FISCAL_DPS_REJECTED', authorityStatus: 400,
      message: expect.stringMatching(/E0718: A assinatura deve ser do emitente da DPS \(CNPJ 12345678000199\) — E0006: Ambiente divergente/),
      fields: [
        { field: 'dps', message: 'E0718: A assinatura deve ser do emitente da DPS (CNPJ 12345678000199)' },
        { field: 'dps', message: 'E0006: Ambiente divergente' },
      ],
    })
  })

  it('5xx, 429, rede e timeout → 503 FISCAL_AUTHORITY_UNAVAILABLE', async () => {
    mockHttp.mockResolvedValueOnce({ status: 503, headers: {}, text: '' })
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE', authorityStatus: 503 })
    mockHttp.mockResolvedValueOnce({ status: 429, headers: {}, text: '' })
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
    mockHttp.mockRejectedValueOnce(new Error('timeout'))
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE', authorityStatus: 0 })
    mockHttp.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
  })

  it('handshake mTLS recusado (EPROTO / CERT_HAS_EXPIRED / "SSL routines") e 401/403 → 409 FISCAL_AUTHORITY_AUTH_FAILED', async () => {
    mockHttp.mockRejectedValueOnce(Object.assign(new Error('write EPROTO'), { code: 'EPROTO' }))
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_AUTHORITY_AUTH_FAILED' })
    mockHttp.mockRejectedValueOnce(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }))
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_AUTHORITY_AUTH_FAILED' })
    mockHttp.mockRejectedValueOnce(new Error('error:0A000086:SSL routines::certificate verify failed'))
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_AUTHORITY_AUTH_FAILED' })
    mockHttp.mockResolvedValueOnce({ status: 403, headers: {}, text: '{"mensagem":"certificado não autorizado"}' })
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_AUTHORITY_AUTH_FAILED', authorityStatus: 403, message: expect.stringMatching(/certificado não autorizado/) })
    mockHttp.mockResolvedValueOnce({ status: 401, headers: {}, text: '' })
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_AUTHORITY_AUTH_FAILED' })
  })

  it('2xx sem XML legível (HTML, JSON sem campo gzip, gzip corrompido) → 502 FISCAL_AUTHORITY_UNKNOWN_RESPONSE — nunca inventa autorização', async () => {
    mockHttp.mockResolvedValueOnce({ status: 200, headers: {}, text: '<html>manutenção</html>' })
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    mockHttp.mockResolvedValueOnce(ok({ mensagem: 'ok' }))
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: Buffer.from('not gzip, not xml').toString('base64') }))
    await expect(adn.transmit(ctx, '<DPS/>')).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
  })
})

describe('adaptador ADN — consultas e eventos', () => {
  it('GET /dps/{id}: 200 {chaveAcesso} → chave; 404 do fisco → null; 404 sem corpo estruturado → 502 (Q-ADV1a)', async () => {
    mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: CHAVE }))
    expect(await adn.queryDpsAccessKey(ctx, DPS_ID)).toBe(CHAVE)
    expect(mockHttp.mock.calls[0][0].url).toBe(`https://sefin.producaorestrita.nfse.gov.br/SefinNacional/dps/${DPS_ID}`)
    expect(mockHttp.mock.calls[0][0].method).toBe('GET')
    // Q-ADV1a: só o 404 ESTRUTURADO do fisco é "DPS sem NFS-e" (conclusivo)
    mockHttp.mockResolvedValueOnce({ status: 404, headers: {}, text: '{"tipoAmbiente":0,"dataHoraProcessamento":"2026-09-30T09:42:39.5553657-03:00","erro":{"codigo":"E2404","descricao":"Não foi gerada uma NFS-e com o identificador de DPS informado"}}' })   // forma REAL (Q-ADV2f)
    expect(await adn.queryDpsAccessKey(ctx, DPS_ID)).toBeNull()
    // 404 vazio ou HTML (gateway/proxy/rota) → ilegível 502: a tentativa fica em voo, nunca F
    for (const text of ['', '<html><body>Not Found</body></html>']) {
      mockHttp.mockResolvedValueOnce({ status: 404, headers: {}, text })
      await expect(adn.queryDpsAccessKey(ctx, DPS_ID)).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    }
    mockHttp.mockResolvedValueOnce({ status: 403, headers: {}, text: '' })
    await expect(adn.queryDpsAccessKey(ctx, DPS_ID)).rejects.toMatchObject({ code: 'FISCAL_AUTHORITY_AUTH_FAILED' })
  })

  it('queryNfse: NFS-e + eventos 404 → authorized; 404 na nota → FISCAL_NFSE_NOT_FOUND', async () => {
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: gz(NFSE_XML) })).mockResolvedValueOnce({ status: 404, headers: {}, text: '' })
    const q = await adn.queryNfse(ctx, CHAVE)
    expect(q).toMatchObject({ accessKey: CHAVE, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T13:16:01-03:00' })
    expect(q.cancelled).toBeUndefined()
    expect(mockHttp.mock.calls[0][0].url).toBe(`https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse/${CHAVE}`)
    expect(mockHttp.mock.calls[1][0].url).toBe(`https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse/${CHAVE}/eventos`)
    mockHttp.mockResolvedValueOnce({ status: 404, headers: {}, text: '{"erros":[{"codigo":"E0001","descricao":"NFS-e não encontrada"}]}' })
    await expect(adn.queryNfse(ctx, CHAVE)).rejects.toMatchObject({ statusCode: 404, code: 'FISCAL_NFSE_NOT_FOUND' })
  })

  it('queryNfse: eventos com e101101 → cancelled (dhProc do evento + motivo); lista vazia → authorized; lista ilegível → unknown', async () => {
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: gz(NFSE_XML) }))
      .mockResolvedValueOnce(ok({ eventos: [{ tipoEvento: '101101', eventoXmlGZipB64: gz(EVENT_XML) }] }))
    const c = await adn.queryNfse(ctx, CHAVE)
    expect(c).toMatchObject({ status: 'cancelled', cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'Erro na emissão: valor & tomador' } })
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: gz(NFSE_XML) })).mockResolvedValueOnce(ok([]))
    expect((await adn.queryNfse(ctx, CHAVE)).status).toBe('authorized')
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: gz(NFSE_XML) })).mockResolvedValueOnce({ status: 200, headers: {}, text: 'algo que não é JSON' })
    expect((await adn.queryNfse(ctx, CHAVE)).status).toBe('unknown')
  })

  it('registerEvent: POST /nfse/{chave}/eventos com {pedidoRegistroEventoXmlGZipB64}; resposta com o evento → dhEvento/protocol; rejeição vai em field "event"', async () => {
    mockHttp.mockResolvedValueOnce(ok({ eventoXmlGZipB64: gz(EVENT_XML) }, 201))
    const r = await adn.registerEvent(ctx, CHAVE, '<pedRegEvento/>')
    const call = mockHttp.mock.calls[0][0]
    expect(call.url).toBe(`https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse/${CHAVE}/eventos`)
    expect(gunzipSync(Buffer.from(JSON.parse(call.body).pedidoRegistroEventoXmlGZipB64, 'base64')).toString()).toBe('<pedRegEvento/>')
    expect(r).toMatchObject({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: `EVT${'0'.repeat(59)}` })
    mockHttp.mockResolvedValueOnce({ status: 400, headers: {}, text: JSON.stringify({ erros: [{ codigo: 'E0822', descricao: 'Fora do prazo de cancelamento' }] }) })
    await expect(adn.registerEvent(ctx, CHAVE, '<pedRegEvento/>')).rejects.toMatchObject({
      statusCode: 422, code: 'FISCAL_DPS_REJECTED', fields: [{ field: 'event', message: 'E0822: Fora do prazo de cancelamento' }],
    })
    // 2xx SEM o evento gerado (ACHADO 1 do gate adversarial, 2026-09-28): NÃO é aceite — 502 ambíguo;
    // a composição grava K em voo e a consulta reconcilia (antes devolvia dhEvento null e a
    // composição cancelava localmente sem a voz do fisco — D-N7 furada)
    mockHttp.mockResolvedValueOnce(ok({ mensagem: 'recebido' }))
    await expect(adn.registerEvent(ctx, CHAVE, '<pedRegEvento/>')).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    mockHttp.mockResolvedValueOnce({ status: 204, headers: {}, text: '' })
    await expect(adn.registerEvent(ctx, CHAVE, '<pedRegEvento/>')).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
  })

  it('municipalTerms: GET /parametros_municipais/{cMun}/convenio; extrai prazo de cancelamento quando existe, guarda raw', async () => {
    mockHttp.mockResolvedValueOnce(ok({ codigoMunicipio: 4106902, parametros: { prazoCancelamentoNfse: 60, permiteCancelamentoSemTomador: true } }))
    const t = await adn.municipalTerms(ctx, '4106902')
    expect(mockHttp.mock.calls[0][0].url).toBe('https://sefin.producaorestrita.nfse.gov.br/SefinNacional/parametros_municipais/4106902/convenio')
    expect(t.cancelDays).toBe(60)
    expect((t.raw as any).codigoMunicipio).toBe(4106902)
    mockHttp.mockResolvedValueOnce(ok({ codigoMunicipio: 4106902 }))
    expect((await adn.municipalTerms(ctx, '4106902')).cancelDays).toBeNull()
  })
})
