import PDFDocument from 'pdfkit'
import { parseNfseXml, unescapeXml } from '@shared/tax-authority'

/**
 * PEÇA @shared/danfse — Documento Auxiliar da NFS-e renderizado POR NÓS a partir
 * do XML autorizado (D-N13; a API de DANFSe do fisco está suspensa — NT 008).
 * Motor de PDF escolhido UMA vez (pdfkit): o futuro `@shared/danfe` usa o mesmo
 * (D-E13/D-E25). Não conhece nota nem banco: recebe o XML e devolve um Buffer.
 *
 * Leitura dos campos: `parseNfseXml` (cabeçalho) + regex nos grupos do DPS
 * embutido (emit/prest, toma, serv, valores) — leiaute fixo do XSD v1.01, sem
 * parser XML novo.
 *
 * [INCERTO: QR Code exige lib] — o projeto não tem gerador de QR e a regra é
 * "sem lib nova": a URL de consulta pública vai em TEXTO legível; quando uma
 * lib for aprovada, troca-se só `drawConsultBox`.
 */

export interface DanfseOptions {
  issuerName:   string
  municipality: string
}

export const NFSE_PUBLIC_QUERY_URL = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave='

function group(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? m[1] : ''
}
function text(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? unescapeXml(m[1].trim()) : null
}
const fmtDoc = (v: string | null): string => {
  if (!v) return '—'
  const d = v.replace(/\D/g, '')
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
  return v
}
const fmtMoney = (v: string | null): string => {
  const n = Number(v ?? '')
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const fmtKey = (k: string): string => k.replace(/(\d{4})(?=\d)/g, '$1 ')

export interface DanfseFields {
  accessKey:   string
  nNFSe:       string | null
  dhProc:      string | null
  nDps:        string | null
  serie:       string | null
  dCompet:     string | null
  prest:       { cnpj: string | null; im: string | null; xNome: string | null }
  toma:        { doc: string | null; xNome: string | null; address: string | null }
  serv:        { cTribNac: string | null; cLocPrestacao: string | null; xDescServ: string | null }
  valores:     { vServ: string | null; pAliq: string | null; vISSQN: string | null; tpRetISSQN: string | null; vLiq: string | null }
  cancelled:   boolean
}

/** Campos do DANFSe lidos do XML da NFS-e (público — a peça é pura para os testes). */
export function extractDanfseFields(nfseXml: string): DanfseFields {
  const parsed = parseNfseXml(nfseXml)
  const inf = group(nfseXml, 'infNFSe')
  const emit = group(inf, 'emit')                          // emitente na NFS-e (dados cadastrais do fisco)
  const dps = group(nfseXml, 'infDPS')
  const prest = group(dps, 'prest')
  const toma = group(dps, 'toma')
  const serv = group(dps, 'serv')
  const val = group(dps, 'valores')
  const valNfse = group(inf, 'valores')                    // valores calculados pelo fisco (vLiq, vISSQN…)
  const end = group(toma, 'end')
  const addrParts = [text(end, 'xLgr'), text(end, 'nro'), text(end, 'xCpl'), text(end, 'xBairro'), text(end, 'cMun'), text(end, 'CEP')].filter(Boolean)
  return {
    accessKey: parsed.accessKey ?? '',
    nNFSe: parsed.nNFSe, dhProc: parsed.dhProc,
    nDps: text(dps, 'nDPS'), serie: text(dps, 'serie'), dCompet: text(dps, 'dCompet'),
    prest: { cnpj: text(prest, 'CNPJ') ?? text(emit, 'CNPJ'), im: text(prest, 'IM') ?? text(emit, 'IM'), xNome: text(emit, 'xNome') },
    toma: { doc: text(toma, 'CNPJ') ?? text(toma, 'CPF'), xNome: text(toma, 'xNome'), address: addrParts.length ? addrParts.join(', ') : null },
    serv: { cTribNac: text(serv, 'cTribNac'), cLocPrestacao: text(serv, 'cLocPrestacao'), xDescServ: text(serv, 'xDescServ') },
    valores: {
      vServ: text(val, 'vServ'), pAliq: text(val, 'pAliq') ?? text(valNfse, 'pAliqAplic'),
      vISSQN: text(valNfse, 'vISSQN') ?? text(val, 'vISSQN'), tpRetISSQN: text(val, 'tpRetISSQN'),
      vLiq: text(valNfse, 'vLiq'),
    },
    cancelled: !!parsed.cancelled,
  }
}

export async function renderDanfse(nfseXml: string, opts: DanfseOptions): Promise<Buffer> {
  const f = extractDanfseFields(nfseXml)
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `DANFSe ${f.nNFSe ?? ''}`.trim() } })
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  const W = doc.page.width - 80
  const label = (t: string, v: string | null | undefined, x?: number) => {
    doc.font('Helvetica-Bold').fontSize(8).text(t, x === undefined ? { continued: true } : { continued: true, indent: 0 })
    doc.font('Helvetica').fontSize(9).text(`  ${v ?? '—'}`)
  }
  const section = (t: string) => {
    doc.moveDown(0.6)
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#222').text(t.toUpperCase())
    doc.moveTo(40, doc.y + 1).lineTo(40 + W, doc.y + 1).lineWidth(0.5).strokeColor('#888').stroke()
    doc.moveDown(0.3)
    doc.fillColor('#000')
  }

  // Cabeçalho
  doc.font('Helvetica-Bold').fontSize(14).text('DANFSe — Documento Auxiliar da NFS-e', { align: 'center' })
  doc.font('Helvetica').fontSize(9).text('Nota Fiscal de Serviço Eletrônica — Sistema Nacional NFS-e', { align: 'center' })
  if (f.cancelled) {
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#b00').text('NFS-e CANCELADA', { align: 'center' }).fillColor('#000')
  }
  doc.moveDown(0.5)
  doc.font('Helvetica-Bold').fontSize(8).text('Chave de acesso')
  doc.font('Courier').fontSize(10).text(fmtKey(f.accessKey))
  doc.moveDown(0.3)
  label('Número da NFS-e:', f.nNFSe)
  label('Emitida em (dhProc):', f.dhProc)
  label('Competência:', f.dCompet)
  label('DPS (série/número):', `${f.serie ?? '—'} / ${f.nDps ?? '—'}`)
  label('Município gerador:', opts.municipality)

  section('Prestador do serviço')
  label('Razão social:', f.prest.xNome ?? opts.issuerName)
  label('CNPJ:', fmtDoc(f.prest.cnpj))
  label('Inscrição municipal:', f.prest.im)

  section('Tomador do serviço')
  label('Nome:', f.toma.xNome)
  label('CPF/CNPJ:', fmtDoc(f.toma.doc))
  label('Endereço:', f.toma.address)

  section('Serviço prestado')
  label('Código de tributação nacional:', f.serv.cTribNac)
  label('Local da prestação (IBGE):', f.serv.cLocPrestacao)
  doc.font('Helvetica-Bold').fontSize(8).text('Descrição:')
  doc.font('Helvetica').fontSize(9).text(f.serv.xDescServ ?? '—', { width: W })

  section('Valores')
  label('Valor do serviço (R$):', fmtMoney(f.valores.vServ))
  label('Alíquota ISSQN (%):', f.valores.pAliq ? fmtMoney(f.valores.pAliq) : null)
  label('Valor do ISSQN (R$):', fmtMoney(f.valores.vISSQN))
  label('ISSQN retido:', f.valores.tpRetISSQN === '2' ? 'Sim (pelo tomador)' : f.valores.tpRetISSQN === '3' ? 'Sim (pelo intermediário)' : 'Não')
  if (f.valores.vLiq) label('Valor líquido (R$):', fmtMoney(f.valores.vLiq))

  section('Consulta pública')
  doc.font('Helvetica').fontSize(8).text('Confira a autenticidade desta NFS-e em:')
  doc.font('Courier').fontSize(8).text(`${NFSE_PUBLIC_QUERY_URL}${f.accessKey}`, { width: W })

  doc.moveDown(1)
  doc.font('Helvetica').fontSize(7).fillColor('#666')
    .text(`Documento auxiliar gerado por ${opts.issuerName} — a NFS-e válida é o XML autorizado pelo fisco.`, { align: 'center' })
  doc.end()
  return done
}
