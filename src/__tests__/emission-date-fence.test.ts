/// <reference types="jest" />
// Cerca da D-IB88 (gate socrático da IB-3, M2; gate do delta, L2 — 2026-10-15): a data de EMISSÃO da nota (= competência fiscal da
// declaração IBS/CBS — D-IB64 — e BASE DOS VENCIMENTOS) tem UM dono, `invoiceEmissionDateFor` (@shared/invoice/emission-date). Os produtores
// do ramo de serviço, a prévia e a grade prévia da negociação perguntam a ele — em NENHUM arquivo um `todayFor` decide
// `dtEmission`/`baseDate`/`competenceDate`/`invoiceDate` por conta própria (atribuição OU propriedade de objeto).
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test-setup' ? [] : tsFiles(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}
const OWNERS = [
  'modules/billing/billing.service.ts',
  'modules/service-orders/service-orders.repository.ts',
  'modules/orders/orders.repository.ts',
  'shared/service-ibscbs-declaration/index.ts',
]

describe('D-IB88 — dono único da data de emissão / competência fiscal / base dos vencimentos', () => {
  it.each(OWNERS)('%s pergunta ao dono (invoiceEmissionDateFor)', rel => {
    expect(read(rel)).toMatch(/invoiceEmissionDateFor\(/)
  })
  it('em NENHUM arquivo um todayFor decide a data da nota (atribuição ou propriedade)', () => {
    const forbidden = /\b(dtEmission|baseDate|competenceDate|invoiceDate)\s*[:=]\s*await\s+todayFor\(/
    const offenders = tsFiles(SRC).filter(f => forbidden.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(SRC, f).replace(/\\/g, '/'))
    expect(offenders).toEqual([])
  })
  it('o dono é o único que liga a data de emissão ao relógio do estabelecimento', () => {
    expect(read('shared/invoice/emission-date.ts')).toMatch(/return todayFor\(schemaName, institutionId, conn\)/)
  })
})

// D-IB91 (gate do delta, L3): os Swagger que enumeram os motivos de omissão citam EXATAMENTE a lista publicada — cópia à mão sem cerca virava
// documentação mentindo quando a constante mudasse.
import { IBSCBS_OMISSIONS } from '../shared/ibscbs-classification'
describe('D-IB91 — Swagger × IBSCBS_OMISSIONS', () => {
  it('toda enumeração "omitted[] ∈ …" nas rotas é a lista publicada', () => {
    const routes = ['modules/service-orders/service-orders.routes.ts', 'modules/billing/billing.routes.ts']
    let seen = 0
    for (const rel of routes) {
      for (const m of read(rel).matchAll(/omitted\[\] ∈ ([a-z\- |]+)\(lista FECHADA/g)) {
        seen++
        expect(m[1].split('|').map(x => x.trim()).filter(Boolean)).toEqual([...IBSCBS_OMISSIONS])
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4)
  })
})
