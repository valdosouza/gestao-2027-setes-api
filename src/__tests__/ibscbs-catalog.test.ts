import { zipSync, strToU8 } from 'fflate'
import { readXlsx, excelSerialToIsoDate, columnIndex, XlsxError } from '@shared/xlsx/read-xlsx'
import {
  parseItCatalog, parsePlaceIndicators, parseNbsList, reconcileWithCalculator,
  CatalogSourceError, itCodesValidAt, conferenceDates, conferenceDateOf, parseCalculatorCodes,
  parseCalculatorList, parseCalculatorPair, rowsNeedingPair, pairKey,
} from '@shared/ibscbs-catalog'

/**
 * IB-1 da fase IBS/CBS (prompt_fase_ibs_cbs.md §10.5/§11): leitor de xlsx, validação das
 * fontes oficiais e conferência IT × Calculadora (D-IB23 + assunção A-IB1).
 */

type Cell = string | number | null
const colName = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26) } return s }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Fabrica um xlsx mínimo: strings inline, números como <v>. */
function makeXlsx(sheets: Record<string, Cell[][]>): Uint8Array {
  const names = Object.keys(sheets)
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml" Type="x"/>`).join('')}</Relationships>`),
  }
  names.forEach((n, i) => {
    const rows = sheets[n].map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
      if (v === null) return ''
      const ref = `${colName(c)}${r + 1}`
      return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`
    }).join('')}</row>`).join('')
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`)
  })
  return zipSync(files)
}

const CLASS_HEADER = ['CST-IBS/CBS', 'Descrição CST-IBS/CBS', 'cClassTrib', 'Nome cClassTrib', 'Descrição cClassTrib',
  'ind_gTribRegular', 'dIniVig', 'dFimVig', 'DataAtualização', 'indNFe', 'indNFCe', 'indNFSe']
const CST_SHEET: Cell[][] = [['CST-IBS/CBS', 'Descrição CST-IBS/CBS', 'ind_gIBSCBS'], ['000', 'Tributação integral', 1], ['200', 'Alíquota reduzida', 1]]
const D2026 = 46023 // 2026-01-01
const D20261001 = 46296

function itXlsx(classRows: Cell[][]) {
  return readXlsx(makeXlsx({ 'cClass 2026-09-01': [CLASS_HEADER, ...classRows], 'CST 2026-09-01': CST_SHEET }))
}

describe('@shared/xlsx', () => {
  it('lê strings inline e números, posicionando pela referência da célula', () => {
    const sheets = readXlsx(makeXlsx({ A: [['x', null, 3], [null, 'y']] }))
    expect(sheets[0].name).toBe('A')
    expect(sheets[0].rows[0]).toEqual(['x', null, 3])
    expect(sheets[0].rows[1]).toEqual([null, 'y'])
  })

  it('recusa planilha acima do teto descompactado (dado não confiável)', () => {
    const buf = makeXlsx({ A: [['x'.repeat(5000)]] })
    expect(() => readXlsx(buf, 1000)).toThrow(XlsxError)
  })

  it('recusa arquivo que não é zip', () => {
    expect(() => readXlsx(strToU8('não sou xlsx'))).toThrow(XlsxError)
  })

  it('converte serial do Excel e referência de coluna', () => {
    expect(excelSerialToIsoDate(D2026)).toBe('2026-01-01')
    expect(columnIndex('A1')).toBe(0)
    expect(columnIndex('AB7')).toBe(27)
  })

  // Gate adversarial da IB-1: 5 KB com <row r="300000000"> ou célula ZZZZZZ1 estouravam o heap (rc 134, sem mensagem).
  it('referência além dos limites do formato (linha > 1.048.576, coluna > XFD) = XlsxError legível', () => {
    expect(() => columnIndex('ZZZZZZ1')).toThrow(/limite do formato/)
    expect(() => columnIndex('XFE1')).toThrow(/limite do formato/)
    expect(columnIndex('XFD1')).toBe(16383)
    const zipWith = (sheetXml: string) => zipSync({
      'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    })
    expect(() => readXlsx(zipWith('<worksheet><sheetData><row r="300000000"><c r="A300000000"><v>1</v></c></row></sheetData></worksheet>')))
      .toThrow(/Linha fora do limite do formato/)
    expect(() => readXlsx(zipWith('<worksheet><sheetData><row r="1"><c r="ZZZZZZ1"><v>1</v></c></row></sheetData></worksheet>')))
      .toThrow(/Coluna além do limite/)
  })

  // Re-score socrático da IB-1: dentro dos limites do formato, 20 mil linhas com uma célula
  // na coluna XFD (90 KB) viravam 2,7 GB de heap — o leitor tem ORÇAMENTO de posições.
  it('linhas largas dentro do formato estouram o orçamento de posições = XlsxError legível', () => {
    const rowsXml = Array.from({ length: 200 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"><v>1</v></c></row>`).join('')
    const buf = zipSync({
      'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`),
    })
    expect(() => readXlsx(buf)).toThrow(/larga demais/)
    expect(() => readXlsx(buf, undefined, 10_000_000)).not.toThrow()   // o teto é parâmetro
  })

  it('serial de data além de 9999-12-31 = XlsxError (nunca RangeError cru)', () => {
    expect(() => excelSerialToIsoDate(1e9)).toThrow(XlsxError)
  })
})

describe('parseItCatalog — tabela oficial do cClassTrib (D-IB23)', () => {
  // Gate adversarial da IB-1: '2026-01-01 lixo' passava (regex sem âncora) e '2026-13-45'
  // virava o diagnóstico errado "IT desatualizado"; serial gigante dava RangeError cru.
  it('data em texto com sufixo, fora do calendário ou serial gigante = linha recusada pelo nome', () => {
    for (const bad of ['2026-01-01 lixo', '2026-13-45', '31/02/2026', 1e9] as Cell[]) {
      expect(() => parseItCatalog(itXlsx([['000', 'x', '000001', 'n', 'd', 0, bad, null, D2026, 1, 1, 1]])))
        .toThrow(/cClassTrib linha 2 \(000001\): dIniVig ausente\/inválida/)
    }
    expect(parseItCatalog(itXlsx([['000', 'x', '000001', 'n', 'd', 0, '2026-01-01', null, D2026, 1, 1, 1]]))
      .classifications[0].validFrom).toBe('2026-01-01')
  })

  it('lê identidade, vigência, flag e aplicabilidade por modelo', () => {
    const cat = parseItCatalog(itXlsx([
      ['000', 'Tributação integral', '000001', 'Situações tributadas integralmente', 'Descrição longa', 0, D2026, null, D20261001, 1, 1, 1],
      ['200', 'Alíquota reduzida', '200052', 'Saúde', 'Desc', 1, D2026, D20261001, D20261001, 1, 0, 0],
    ]))
    expect(cat.csts.map(c => c.id)).toEqual(['000', '200'])
    const [a, b] = cat.classifications
    expect(a).toMatchObject({ code: '000001', cst: '000', validFrom: '2026-01-01', validUntil: null, requiresRegularTaxation: false, models: ['SE', '55', '65'] })
    expect(b).toMatchObject({ code: '200052', requiresRegularTaxation: true, validUntil: '2026-10-01', models: ['55'] })
  })

  it('recusa CST que não é o prefixo do código (E0959) e flag fora de 0/1', () => {
    expect(() => parseItCatalog(itXlsx([
      ['200', 'x', '000001', 'n', 'd', 2, D2026, null, D2026, 1, 1, 1],
    ]))).toThrow(/prefixo do código[\s\S]*ind_gTribRegular/)
  })

  it('recusa texto acima do tamanho da coluna (o banco do dev truncaria em silêncio)', () => {
    expect(() => parseItCatalog(itXlsx([
      ['000', 'x', '000001', 'n', 'd'.repeat(2001), 0, D2026, null, D2026, 1, 1, 1],
    ]))).toThrow(/descrição com 2001 > 2000/)
  })

  it('estrutura oficial mudada (coluna sumiu) = erro ALTO', () => {
    const sheets = readXlsx(makeXlsx({ 'cClass': [CLASS_HEADER.filter(h => h !== 'dIniVig')], 'CST': CST_SHEET }))
    expect(() => parseItCatalog(sheets)).toThrow(/estrutura oficial não reconhecida/)
  })

  it('itCodesValidAt respeita dIniVig/dFimVig', () => {
    const cat = parseItCatalog(itXlsx([
      ['000', 'x', '000001', 'n', 'd', 0, D2026, null, D2026, 1, 1, 1],
      ['200', 'x', '200052', 'n', 'd', 0, D2026, D20261001, D2026, 1, 1, 1],
    ]))
    expect([...itCodesValidAt(cat, '2026-10-01')].sort()).toEqual(['000001', '200052'])
    expect([...itCodesValidAt(cat, '2026-10-02')]).toEqual(['000001'])
  })
})

describe('parsePlaceIndicators — Anexo VII (cIndOp)', () => {
  const HEADER = ['Código indOp', 'Tipo de operação', 'Característica do fornecimento',
    'Local do fornecimento a ser identificado no DFe', 'LC', 'Obs', 'indNFe', 'indNFSe']
  it('completa o código numérico com zeros e lê a aplicabilidade S', () => {
    const r = parsePlaceIndicators(readXlsx(makeXlsx({ 'cIndOp Public': [HEADER,
      [10101, 'Bem Móvel Material', 'Presencial', 'Local da entrega', 'y', '', 'S', ''],
      ['100301', 'Demais serviços, em operações onerosas', 'Execução', 'Domicílio do adquirente', 'y', '', '', 'S'],
    ] })))
    expect(r).toEqual([
      { code: '010101', description: 'Bem Móvel Material — Presencial — Local da entrega', models: ['55'] },
      { code: '100301', description: 'Demais serviços, em operações onerosas — Execução — Domicílio do adquirente', models: ['SE'] },
    ])
  })

  // Passeio logado da IB-1: 100301 (adquirente) × 100302 (destinatário) apareciam com a MESMA
  // descrição na lista de apoio — o local do fornecimento é o que os distingue.
  it('pares que só diferem no LOCAL do fornecimento ganham descrições distintas', () => {
    const r = parsePlaceIndicators(readXlsx(makeXlsx({ 'cIndOp Public': [HEADER,
      ['100301', 'Demais serviços', 'Execução', 'Domicílio do adquirente', 'y', '', '', 'S'],
      ['100302', 'Demais serviços', 'Execução', 'Domicílio do destinatário', 'y', '', '', 'S'],
    ] })))
    expect(new Set(r.map(x => x.description)).size).toBe(2)
  })

  it('estrutura sem a coluna do local do fornecimento = erro ALTO', () => {
    expect(() => parsePlaceIndicators(readXlsx(makeXlsx({ 'cIndOp Public': [
      ['Código indOp', 'Tipo de operação', 'Característica do fornecimento', 'indNFe', 'indNFSe'],
      ['100301', 'Demais serviços', 'Execução', '', 'S'],
    ] })))).toThrow(/estrutura oficial não reconhecida/)
  })

  // Gate adversarial da IB-1: 'Sim' no lugar de 'S' desativava em silêncio as 28 aplicabilidades na NFS-e.
  it('indicador fora do vocabulário oficial (S / N / vazio) = recusa ALTA', () => {
    for (const bad of ['Sim', '1', 'X']) {
      expect(() => parsePlaceIndicators(readXlsx(makeXlsx({ 'cIndOp Public': [HEADER,
        ['100301', 'Demais serviços', 'Execução', 'x', 'y', '', '', bad],
      ] })))).toThrow(`indNFSe "${bad}" não é S/N/vazio`)
    }
  })
})

describe('parseNbsList — dados abertos da Calculadora', () => {
  it('aceita 9 dígitos e recusa o resto', () => {
    expect(parseNbsList([{ codigo: '115021000', descricao: 'Desenvolvimento' }])).toEqual([{ code: '115021000', description: 'Desenvolvimento' }])
    expect(() => parseNbsList([{ codigo: '1.1502.10.00', descricao: 'x' }])).toThrow(CatalogSourceError)
    expect(() => parseNbsList({})).toThrow(/não é um array/)
  })
})

/** Testes de PRESENÇA (A-IB1/A-IB2): sem lista com documentos nem pares — o foco é unconfirmed/recusas. */
const NO_ATTR = { entries: new Map(), pairs: new Map() }

describe('reconcileWithCalculator — D-IB23 + A-IB1', () => {
  const cat = () => parseItCatalog(itXlsx([
    ['000', 'x', '000001', 'n', 'd', 0, D2026, null, D2026, 1, 1, 1],
    ['000', 'x', '000006', 'n', 'd', 0, D2026, null, D2026, 0, 0, 1],
  ]))

  it('código só na Calculadora = IT desatualizado → carga recusada inteira', () => {
    expect(() => reconcileWithCalculator(cat(), ['000001', '000006', '000099'], '2027-01-01', NO_ATTR))
      .toThrow(/IT informado está desatualizado[\s\S]*000099/)
  })

  // gate adversarial do delta da Rodada 3: a A-IB1 vale em TODA data consultada, não só na da carga
  it('código só na Calculadora em OUTRA data de conferência também recusa a carga', () => {
    expect(() => reconcileWithCalculator(cat(),
      new Map([['2027-01-01', ['000001', '000006']], ['2027-06-01', ['000001', '999998']]]), '2027-01-01', NO_ATTR))
      .toThrow(/desatualizado[\s\S]*cClassTrib 999998 \(2027-06-01\)/)
  })

  it('código só no IT = ainda não confirmado pela Calculadora → carregado SEM aplicabilidade', () => {
    const r = reconcileWithCalculator(cat(), ['000001'], '2027-01-01', NO_ATTR)
    expect(r.unconfirmed).toEqual([{ code: '000006', validFrom: '2026-01-01', conferredAt: '2027-01-01' }])
    expect(r.itValid).toBe(2)
  })

  // Gate socrático da IB-1: Calculadora (API "VERSÃO BETA") respondendo 200 com [] deixava
  // TODO código "não confirmado" e o --vai apagava a aplicabilidade do catálogo inteiro.
  it('lista VAZIA da Calculadora na data da carga = carga recusada (nunca apaga a aplicabilidade)', () => {
    expect(() => reconcileWithCalculator(cat(), [], '2027-01-01', NO_ATTR)).toThrow(/VAZIA[\s\S]*recusada/)
    expect(() => reconcileWithCalculator(cat(), new Map([['2027-02-01', ['000001']]]), '2027-01-01', NO_ATTR))
      .toThrow(/sem lista de cClassTrib na data da carga/)
    // re-score socrático: [] numa data de conferência SECUNDÁRIA também recusa
    expect(() => reconcileWithCalculator(cat(), new Map([['2026-10-10', ['000001', '000006']], ['2027-01-01', []]]), '2026-10-10', NO_ATTR))
      .toThrow(/VAZIA[\s\S]*data 2027-01-01/)
  })

  // A-IB2: linha com dIniVig FUTURA é conferida na PRÓPRIA data; sem lista dessa data = não confirmada.
  it('linha de vigência futura: conferida na própria dIniVig; sem a lista dessa data fica sem aplicabilidade', () => {
    const D20270101 = 46388
    const future = () => parseItCatalog(itXlsx([
      ['000', 'x', '000001', 'n', 'd', 0, D2026, null, D2026, 1, 1, 1],
      ['000', 'x', '000007', 'n', 'd', 0, D20270101, null, D2026, 0, 0, 1],
    ]))
    expect(conferenceDates(future(), '2026-10-10')).toEqual(['2026-10-10', '2027-01-01'])

    const without = reconcileWithCalculator(future(), ['000001'], '2026-10-10', NO_ATTR)
    expect(without.unconfirmed).toEqual([{ code: '000007', validFrom: '2027-01-01', conferredAt: '2027-01-01' }])

    const withList = reconcileWithCalculator(future(),
      new Map([['2026-10-10', ['000001']], ['2027-01-01', ['000001', '000007']]]), '2026-10-10', NO_ATTR)
    expect(withList.unconfirmed).toEqual([])
    expect(withList.dates).toEqual(['2026-10-10', '2027-01-01'])
  })

  it('conferenceDateOf: a data da vigência mais perto da carga (expirada → dFimVig; futura → dIniVig)', () => {
    expect(conferenceDateOf({ validFrom: '2026-01-01', validUntil: null }, '2026-10-10')).toBe('2026-10-10')
    expect(conferenceDateOf({ validFrom: '2026-01-01', validUntil: '2026-03-31' }, '2026-10-10')).toBe('2026-03-31')
    expect(conferenceDateOf({ validFrom: '2027-01-01', validUntil: null }, '2026-10-10')).toBe('2027-01-01')
  })

  it('parseCalculatorCodes: estrutura mudada (campo renomeado / código fora de 6 dígitos) = erro ALTO', () => {
    expect(parseCalculatorCodes([{ codigo: '000001' }, { codigo: '200052' }], '2026-10-10')).toEqual(['000001', '200052'])
    expect(() => parseCalculatorCodes([{ code: '000001' }], '2026-10-10')).toThrow(/estrutura da lista de cClassTrib mudou/)
    expect(() => parseCalculatorCodes({ itens: [] }, '2026-10-10')).toThrow(/não é um array/)
  })
})

// D-IB28 (a) (Rodada 3, Valdo 2026-10-10): além da presença, a carga confere na Calculadora os DOIS
// atributos que o código consome — aceitação na NFS-e (lista tipo 91 + par) e tributação regular (par).
describe('reconcileWithCalculator — atributos IT × Calculadora (D-IB28 a)', () => {
  // IT: 000001 aceito na NFS-e sem regular · 200052 aceito na NFS-e e EXIGE regular · 200053 NÃO aceito na NFS-e
  const cat = () => parseItCatalog(itXlsx([
    ['000', 'x', '000001', 'n', 'd', 0, D2026, null, D2026, 1, 1, 1],
    ['200', 'x', '200052', 'n', 'd', 1, D2026, null, D2026, 1, 0, 1],
    ['200', 'x', '200053', 'n', 'd', 0, D2026, null, D2026, 1, 0, 0],
  ]))
  const D = '2026-10-10'
  const list = (nfse: Record<string, boolean>) => new Map([[D, Object.entries(nfse).map(([code, v]) => ({ code, nfse: v }))]])
  const codesOf = (m: Map<string, Array<{ code: string }>>) => new Map([...m].map(([d, l]) => [d, l.map(e => e.code)]))
  // D-IB113: o par traz o grupo IBS/CBS — por padrão o do CST no IT (000/200 levam o grupo)
  const pairs = (p: Record<string, { valid: boolean; requiresRegular: boolean; requiresGroup?: boolean }>) =>
    new Map(Object.entries(p).map(([code, v]) => [pairKey(D, code), { requiresGroup: true, ...v }]))

  it('tudo coerente: nenhuma linha bloqueada; IT que não aceita e Calculadora que aceita = só informativo', () => {
    const entries = list({ '000001': true, '200052': true, '200053': true })
    const r = reconcileWithCalculator(cat(), codesOf(entries), D, {
      entries, pairs: pairs({ '000001': { valid: true, requiresRegular: false }, '200052': { valid: true, requiresRegular: true } }),
    })
    expect(r.blocked).toEqual([])
    expect(r.divergences).toEqual([expect.stringMatching(/200053.*vale o IT/)])
  })

  it('divergência de ATRIBUTO = a linha perde a aplicabilidade na NFS-e (fail-closed), com o motivo', () => {
    const entries = list({ '000001': false, '200052': true, '200053': false })
    const r = reconcileWithCalculator(cat(), codesOf(entries), D, {
      entries, pairs: pairs({ '200052': { valid: true, requiresRegular: false } }),
    })
    expect(r.blocked.map(b => [b.code, b.model, b.reason])).toEqual([
      ['000001', 'SE', 'a lista da Calculadora não aceita na NFS-e'],
      ['200052', 'SE', expect.stringMatching(/tributação regular diverge \(IT exige × Calculadora não exige\)/)],
    ])
  })

  it('par não consultado ou inválido = sem aplicabilidade na NFS-e (nunca presume)', () => {
    const entries = list({ '000001': true, '200052': true, '200053': false })
    const r = reconcileWithCalculator(cat(), codesOf(entries), D, {
      entries, pairs: pairs({ '200052': { valid: false, requiresRegular: true } }),
    })
    expect(r.blocked.map(b => [b.code, b.reason])).toEqual([
      ['000001', 'par NFS-e × cClassTrib não consultado na Calculadora'],
      ['200052', 'o par NFS-e × cClassTrib não é válido na Calculadora'],
    ])
  })

  it('rowsNeedingPair: só as linhas aceitas na NFS-e pelo IT E pela lista, na data de conferência delas', () => {
    expect(rowsNeedingPair(cat(), list({ '000001': true, '200052': false, '200053': true }), D))
      .toEqual([{ date: D, code: '000001' }])
  })

  it('parseCalculatorList / parseCalculatorPair: estrutura mudada = erro ALTO', () => {
    expect(parseCalculatorList([{ codigo: '000001', tiposDfeClassificacao: [{ tipo: 55 }, { tipo: 91 }] },
      { codigo: '200053', tiposDfeClassificacao: [{ tipo: 55 }] }], D))
      .toEqual([{ code: '000001', nfse: true }, { code: '200053', nfse: false }])
    expect(() => parseCalculatorList([{ codigo: '000001' }], D)).toThrow(/tiposDfeClassificacao ausente/)
    expect(parseCalculatorPair({ validoParaSiglaDfeInformado: true, exigeGrupoTributacaoRegular: false, exigeGrupoIbsCbs: true }, '000001', D))
      .toEqual({ valid: true, requiresRegular: false, requiresGroup: true })
    // D-IB113: sem o exigeGrupoIbsCbs (ou fora do tipo) = estrutura mudada — nunca vira "leva o grupo"
    expect(() => parseCalculatorPair({ validoParaSiglaDfeInformado: true, exigeGrupoTributacaoRegular: false }, '000001', D)).toThrow(/mudou de estrutura/)
    expect(() => parseCalculatorPair({ validoParaSiglaDfeInformado: true, exigeGrupoTributacaoRegular: false, exigeGrupoIbsCbs: 'true' }, '000001', D)).toThrow(/mudou de estrutura/)
    expect(() => parseCalculatorPair({ valido: true }, '000001', D)).toThrow(/mudou de estrutura/)
  })
})
