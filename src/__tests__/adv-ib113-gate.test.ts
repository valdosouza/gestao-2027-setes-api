/// <reference types="jest" />
// GATE ADVERSARIAL da D-IB113 (Valdo 2026-11-01 — prompt_fase_ibs_cbs.md §13.8, fim): CST com ind_gIBSCBS = 0 é RECUSADO no ERP;
// promessa atacada: NENHUM caminho congela no ramo da nota um grupo IBS/CBS de CST que não leva o grupo, e cadastro (salvar, lista,
// selo), prévia e faturamento concordam. Testes do QA adversarial (skill testar-adversarial §4.6 — achado confirmado vira teste).
//
// Parte 1 — PURA (catálogo simulado): bordas da fonte, do indicador lido do banco, de N serviços e da sonda do boot.
// Parte 2 — AO VIVO (opt-in `IB113_ADV_LIVE=1`): SÓ em schemas DESCARTÁVEIS `setes_ib113_adv_*` no MariaDB do `.env` (cópia do catálogo
// por CREATE TABLE … LIKE + INSERT … SELECT — só LEITURA de setes_central), apagados no fim. `it.failing` = achado CONFIRMADO e ainda
// aberto (o teste afirma o comportamento CERTO e falha hoje); `ADV_SHOW=1` mostra a falha.
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import { CatalogSourceError, parseCalculatorPair, parseItCatalog } from '@shared/ibscbs-catalog'
import {
  Queryable, assertIbscbsCatalogSchema, classificationVerdictsAt, evaluateIbscbsDeclaration, ServicePresumption,
} from '@shared/ibscbs-classification'

const LIVE = process.env.IB113_ADV_LIVE === '1'
const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing

// ---------------------------------------------------------------------------------------------------------------------------
// Parte 1 — pura
// ---------------------------------------------------------------------------------------------------------------------------

const CLASS_HEADER = ['CST-IBS/CBS', 'Descrição CST-IBS/CBS', 'cClassTrib', 'Nome cClassTrib', 'Descrição cClassTrib', 'ind_gTribRegular',
  'dIniVig', 'dFimVig', 'DataAtualização', 'indNFe', 'indNFCe', 'indNFSe']
const classRow = (cst: string, code: string) => [cst, 'x', code, 'n', 'd', 0, '2026-01-01', null, '2026-01-01', 1, 1, 1]

describe('ADV-IB113 fonte (parse.ts) — o indicador nunca vem da aba errada nem de valor torto', () => {
  it('a aba cClass ganhando uma coluna ind_gIBSCBS ANTES da aba CST: a carga é RECUSADA (CST repetido), nunca lê a aba errada calada', () => {
    const cClass = { name: 'cClass', rows: [[...CLASS_HEADER, 'ind_gIBSCBS'], [...classRow('000', '000001'), 1], [...classRow('000', '000002'), 1]] }
    const cst = { name: 'CST', rows: [['CST-IBS/CBS', 'Descrição CST-IBS/CBS', 'ind_gIBSCBS'], ['000', 'Tributação integral', 1]] }
    expect(() => parseItCatalog([cClass, cst] as any)).toThrow(CatalogSourceError)
    try { parseItCatalog([cClass, cst] as any) } catch (e) { expect((e as CatalogSourceError).problems.join('|')).toMatch(/CST 000 repetido/) }
  })

  it('o mesmo CST duas vezes com indicadores DIFERENTES = carga recusada (nunca "o primeiro vence")', () => {
    const cClass = { name: 'cClass', rows: [CLASS_HEADER, classRow('410', '410014')] }
    const cst = { name: 'CST', rows: [['CST-IBS/CBS', 'Descrição CST-IBS/CBS', 'ind_gIBSCBS'], ['410', 'Imunidade', 0], ['410', 'Imunidade', 1]] }
    expect(() => parseItCatalog([cClass, cst] as any)).toThrow(/CST 410 repetido/)
  })

  it.each([['TRUE', 'TRUE'], ['verdadeiro', 'verdadeiro'], ['1,0', '1,0'], ['-1', -1], ['0.0', '0.0']])(
    'ind_gIBSCBS %s → recusado (só 0/1 viram indicador)', (_n, v) => {
      const cClass = { name: 'cClass', rows: [CLASS_HEADER, classRow('000', '000001')] }
      const cst = { name: 'CST', rows: [['CST-IBS/CBS', 'Descrição CST-IBS/CBS', 'ind_gIBSCBS'], ['000', 'Tributação integral', v]] }
      expect(() => parseItCatalog([cClass, cst] as any)).toThrow(/ind_gIBSCBS .* não é 0\/1/)
    })

  it('a Calculadora sem exigeGrupoIbsCbs booleano no par = carga inteira recusada (fail-loud, nunca vira "não exige")', () => {
    const base = { validoParaSiglaDfeInformado: true, exigeGrupoTributacaoRegular: false }
    expect(() => parseCalculatorPair(base, '000001', '2026-11-01')).toThrow(CatalogSourceError)
    expect(() => parseCalculatorPair({ ...base, exigeGrupoIbsCbs: 'true' }, '000001', '2026-11-01')).toThrow(CatalogSourceError)
    expect(() => parseCalculatorPair({ ...base, exigeGrupoIbsCbs: null }, '000001', '2026-11-01')).toThrow(CatalogSourceError)
  })
})

/** Catálogo simulado: o CST de cada código e o indicador do CST como o BANCO o devolveria (inclusive torto, sem o CHECK). */
function catalogWith(groups: Record<string, unknown>): Queryable {
  return {
    query: async (sql: string, params: any = []) => {
      if (/tb_tax_ibscbs_classification_validity v/.test(sql)) {
        const codes: string[] = Array.isArray(params[1]) ? params[1] : [params[1]]
        return [codes.map(code => ({
          code, cst: code.slice(0, 3), name: `n ${code}`, validFrom: '2026-01-01', validUntil: null, requiresRegular: 'N',
          absentSince: null, applicable: 1, requiresGroup: groups[code.slice(0, 3)],
        }))]
      }
      if (/tb_ibscbs_place_indicator p/.test(sql)) return [[{ code: params[1], description: 'x', applicable: 1 }]]
      if (/tb_nbs/.test(sql)) return [[{ ok: 1 }]]
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
    },
  }
}

describe('ADV-IB113 peça — indicador torto lido do banco (sem o CHECK) é RECUSADO; só "S" exato aceita', () => {
  it.each([['s'], [' S'], ['S\u0000'], ['1'], ['Y'], [''], [0], [1], [true]])('requires_ibscbs_group %p → cst-without-group', async (g) => {
    const v = (await classificationVerdictsAt(catalogWith({ '000': g }), ['000001'], 'SE', '2026-11-01')).get('000001')!
    expect(v).toMatchObject({ accepted: false, reason: 'cst-without-group' })
  })
})

describe('ADV-IB113 faturamento — N serviços na mesma nota', () => {
  const svc = (productId: number, classificationCode: string): ServicePresumption => ({
    productId, description: `Serviço ${productId}`, field: `product.${productId}`, nbs: '115021000', classificationCode, placeIndicatorCode: '100301',
  })
  const cat = () => catalogWith({ '000': 'S', '410': 'N', '811': null })

  it('000001 + 410014 na mesma nota → divergente: NENHUM grupo congelado; depois da obrigação 422 MULTI_DECLARATION', async () => {
    const before = await evaluateIbscbsDeclaration(cat(), [svc(1, '000001'), svc(2, '410014')], '2026-12-20', '2027-01-01')
    expect(before.declaration.group).toBeNull()
    expect(before.refusal).toBeNull()
    const after = await evaluateIbscbsDeclaration(cat(), [svc(1, '000001'), svc(2, '410014')], '2027-01-05', '2027-01-01')
    expect(after.declaration.group).toBeNull()
    expect(after.refusal?.code).toBe('INVOICE_SERVICE_MULTI_DECLARATION')
  })

  it('dois serviços com o MESMO cClassTrib de CST sem o grupo → grupo omitido e, depois da obrigação, 422 nomeando OS DOIS', async () => {
    const after = await evaluateIbscbsDeclaration(cat(), [svc(1, '410014'), svc(2, '410014')], '2027-01-05', '2027-01-01')
    expect(after.declaration.group).toBeNull()
    expect(after.declaration.omitted).toEqual(['cst-without-group'])
    expect(after.refusal?.code).toBe('INVOICE_SERVICE_IBSCBS_REQUIRED')
    expect(after.refusal?.message).toMatch(/Serviço 1, Serviço 2/)
    expect(after.refusal?.fields.map(f => f.field)).toEqual(['product.1', 'product.2'])
  })

  it('indicador desconhecido (NULL) também nunca congela o grupo — e a NBS segue sozinha antes da obrigação (D-IB62)', async () => {
    const before = await evaluateIbscbsDeclaration(cat(), [svc(1, '811001')], '2026-12-20', '2027-01-01')
    expect(before.declaration.group).toBeNull()
    expect(before.declaration.nbs).toBe('115021000')
    expect(before.declaration.omitted).toEqual(['cst-without-group'])
  })
})

describe('ADV-IB113-02 sonda do boot — PK ocupada (1062) e espera pela trava (1205) só acontecem SEM o CHECK: o boot diz o script', () => {
  const db = (insertErr: object) => {
    const conn = {
      beginTransaction: jest.fn(async () => undefined), rollback: jest.fn(async () => undefined), release: jest.fn(),
      query: jest.fn(async () => { throw Object.assign(new Error('x'), insertErr) }),
    }
    return {
      conn, getConnection: jest.fn(async () => conn),
      query: jest.fn(async (sql: string) => (/COUNT\(\*\)/.test(sql) ? [[{ n: 0 }]] : [[]])),
    }
  }
  it('PK da sonda ocupada (1062) → o boot NÃO sobe e diz o script (com o CHECK a recusa vem antes do índice)', async () => {
    const d = db({ errno: 1062, code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry '998' for key 'PRIMARY'" })
    await expect(assertIbscbsCatalogSchema(d as any)).rejects.toThrow(/colidiu com a PK \(1062\).*sql\/73_ibscbs_cst_requires_group\.sql/)
    expect(d.conn.rollback).toHaveBeenCalled()
  })
  it('sonda esperando trava (carga do catálogo em andamento com o CHECK AUSENTE) → 1205 vira a frase "aplique o script 73"', async () => {
    const d = db({ errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT', sqlMessage: 'Lock wait timeout exceeded; try restarting transaction' })
    await expect(assertIbscbsCatalogSchema(d as any)).rejects.toThrow(/esperou a trava da carga do catálogo \(1205\).*sql\/73/)
  })
  it('outro erro (sem privilégio, conexão) sobe CRU — só 1062/1205 provam a falta do CHECK', async () => {
    const d = db({ errno: 1142, code: 'ER_TABLEACCESS_DENIED_ERROR', sqlMessage: 'INSERT command denied' })
    await expect(assertIbscbsCatalogSchema(d as any)).rejects.toMatchObject({ errno: 1142 })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
// Parte 2 — ao vivo (opt-in), só schemas descartáveis setes_ib113_adv_*
// ---------------------------------------------------------------------------------------------------------------------------

const SQL73 = path.resolve(__dirname, '../../../sql/73_ibscbs_cst_requires_group.sql')
const IT_FILE = path.resolve(__dirname, '../../../../Infra-IA/setes-api/integracoes/nfse-adn/classificacao-ibs-cbs/it-2025-002-v1-70-cclasstrib.xlsx')
const cfg = () => ({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD })
const statements73 = async (): Promise<string[]> => {
  const { splitStatements } = await import('../migrations/runner')
  return splitStatements(fs.readFileSync(SQL73, 'utf8')).filter(st => !/^USE\s/i.test(st.trim()))
}

;(LIVE ? describe : describe.skip)('ADV-IB113 ao vivo — schemas descartáveis setes_ib113_adv_*', () => {
  jest.setTimeout(600_000)

  failing('ADV-IB113-01 (LOW): em sessão NÃO estrita (modo do servidor do dev) o SQL direto "Sem grupo" no CST 410 vira \'S\' e PASSA o CHECK — '
    + 'o CHECK binário vê o valor JÁ truncado; o certo é recusar', async () => {
    const S = 'setes_ib113_adv_ns'
    const c = await mysql.createConnection(cfg())
    try {
      await c.query(`DROP DATABASE IF EXISTS \`${S}\``)
      await c.query(`CREATE DATABASE \`${S}\``)
      await c.query(`CREATE TABLE \`${S}\`.tb_tax_ibscbs LIKE setes_central.tb_tax_ibscbs`)
      await c.query(`INSERT INTO \`${S}\`.tb_tax_ibscbs SELECT * FROM setes_central.tb_tax_ibscbs`)
      await c.query(`USE \`${S}\``)
      for (const st of await statements73()) await c.query(st)
      await c.query(`SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'`)   // o servidor do dev roda sem STRICT (PADROES §5)
      const outcome = await c.query(`UPDATE \`${S}\`.tb_tax_ibscbs SET requires_ibscbs_group = 'Sem grupo' WHERE id = '410'`)
        .then(() => 'aceito', (e: any) => `recusado ${e.errno}`)
      const [[row]] = await c.query<any[]>(`SELECT requires_ibscbs_group g FROM \`${S}\`.tb_tax_ibscbs WHERE id = '410'`)
      // hoje: aceito e gravado 'S' — a peça passaria a ACEITAR toda classificação do CST 410 (o ERP congelaria o grupo proibido)
      expect({ outcome, stored: row.g }).toEqual({ outcome: 'recusado 4025', stored: null })
    } finally {
      await c.query(`DROP DATABASE IF EXISTS \`${S}\``).catch(() => undefined)
      await c.end()
    }
  })

  it('invariante: com o CHECK, a sonda do boot NÃO espera a trava da carga do catálogo (SELECT … FOR UPDATE aberto); sem ele, espera e cai em 1205', async () => {
    const S = 'setes_ib113_adv_lock'
    const admin = await mysql.createConnection(cfg())
    const holder = await mysql.createConnection(cfg())
    const probe = mysql.createPool({ ...cfg(), connectionLimit: 2 })
    probe.on('connection', (k: any) => { k.query('SET SESSION innodb_lock_wait_timeout = 2') })
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${S}\``)
      await admin.query(`CREATE DATABASE \`${S}\``)
      // D-IB120: o boot também lê a identidade do cClassTrib (CST desconhecido em uso) — a cópia leva a tabela
      for (const t of ['tb_tax_ibscbs', 'tb_tax_ibscbs_classification', 'tb_tax_ibscbs_classification_validity']) await admin.query(`CREATE TABLE \`${S}\`.${t} LIKE setes_central.${t}`)
      await admin.query(`INSERT INTO \`${S}\`.tb_tax_ibscbs SELECT * FROM setes_central.tb_tax_ibscbs`)
      await admin.query(`USE \`${S}\``)
      for (const st of await statements73()) await admin.query(st)
      await admin.query(`UPDATE \`${S}\`.tb_tax_ibscbs SET requires_ibscbs_group = 'S'`)
      await holder.beginTransaction()
      await holder.query(`SELECT id FROM \`${S}\`.tb_tax_ibscbs FOR UPDATE`)
      const t0 = Date.now()
      await expect(assertIbscbsCatalogSchema(probe as any, S)).resolves.toBe('ok')
      expect(Date.now() - t0).toBeLessThan(1500)
      await holder.rollback()
      await admin.query(`ALTER TABLE \`${S}\`.tb_tax_ibscbs DROP CONSTRAINT ck_tax_ibscbs_requires_group`)
      await holder.beginTransaction()
      await holder.query(`SELECT id FROM \`${S}\`.tb_tax_ibscbs FOR UPDATE`)
      await expect(assertIbscbsCatalogSchema(probe as any, S)).rejects.toThrow(/esperou a trava da carga do catálogo \(1205\)/)
      await holder.rollback()
    } finally {
      await holder.rollback().catch(() => undefined)
      await admin.query(`DROP DATABASE IF EXISTS \`${S}\``).catch(() => undefined)
      await admin.end(); await holder.end(); await probe.end()
    }
  })

  it('MATRIZ sobre o IT oficial (carga REAL): para TODO cClassTrib × data × estado do indicador — lista ⇔ salvar ⇔ selo; '
    + 'grupo congelado ⇒ CST com "S"; faturamento ⇔ veredito da data do fato', async () => {
    const S = 'setes_ib113_adv_mx'
    const { default: pool } = await import('../shared/db/connection')
    const { readXlsx } = await import('../shared/xlsx/read-xlsx')
    const { applyCatalog } = await import('../shared/ibscbs-catalog')
    const piece = await import('../shared/ibscbs-classification')
    const raw = await pool.getConnection()
    const rewrite = (sql: string) => sql.split('setes_central.').join(`\`${S}\`.`)
    const conn: any = { query: (sql: string, p?: unknown[]) => raw.query(rewrite(sql), p),
      beginTransaction: () => raw.beginTransaction(), commit: () => raw.commit(), rollback: () => raw.rollback() }
    const fails: string[] = []
    const tally = { codes: 0, saved: 0, refusedGroup: 0, declared: 0 }
    try {
      await raw.query(`DROP DATABASE IF EXISTS \`${S}\``)
      await raw.query(`CREATE DATABASE \`${S}\``)
      for (const t of ['tb_tax_ibscbs', 'tb_tax_ibscbs_classification', 'tb_tax_ibscbs_classification_validity',
        'tb_tax_ibscbs_classification_applicability', 'tb_ibscbs_place_indicator', 'tb_ibscbs_place_indicator_applicability', 'tb_nbs']) {
        await raw.query(`CREATE TABLE \`${S}\`.${t} LIKE setes_central.${t}`)
        await raw.query(`INSERT INTO \`${S}\`.${t} SELECT * FROM setes_central.${t}`)
      }
      await raw.query(`USE \`${S}\``)
      for (const st of await statements73()) await raw.query(st)
      await applyCatalog(conn, { it: parseItCatalog(readXlsx(fs.readFileSync(IT_FILE))), itVersion: 'IT 2025.002 v1.70', unconfirmed: [],
        models: ['SE'], apply: true, allowShrink: true })
      const [[nbs]] = await raw.query<any[]>(`SELECT code FROM \`${S}\`.tb_nbs WHERE deleted = 'N' ORDER BY code LIMIT 1`)
      const [[place]] = await raw.query<any[]>(`SELECT p.code FROM \`${S}\`.tb_ibscbs_place_indicator p JOIN \`${S}\`.tb_ibscbs_place_indicator_applicability a
        ON a.code = p.code AND a.model = 'SE' AND a.deleted = 'N' WHERE p.deleted = 'N' ORDER BY p.code LIMIT 1`)
      const [codeRows] = await raw.query<any[]>(`SELECT code FROM \`${S}\`.tb_tax_ibscbs_classification ORDER BY code`)
      const codes = (codeRows as any[]).map(r => String(r.code))
      tally.codes = codes.length
      const round = async (label: string) => {
        const [g] = await raw.query<any[]>(`SELECT id, requires_ibscbs_group g FROM \`${S}\`.tb_tax_ibscbs`)
        const groupOf = new Map((g as any[]).map(r => [String(r.id), r.g]))
        for (const date of ['2026-11-01', '2027-01-01']) {
          for (const code of codes) {
            const inLookup = (await piece.listClassificationsLookup(code, date, 'SE', conn)).some(r => r.code === code)
            const saveOk = await piece.assertServiceClassification(conn, { ibscbs: { classificationCode: code, placeIndicatorCode: place.code } }, date)
              .then(() => true, (e: any) => { if (e?.statusCode !== 422) throw e; return false })
            const selo = (await piece.classificationAcceptance(conn, code, place.code, date)).classification
            if (!(inLookup === saveOk && saveOk === selo)) fails.push(`[${label}] ${code}@${date}: lista=${inLookup} salvar=${saveOk} selo=${selo}`)
            const ev = await piece.evaluateIbscbsDeclaration(conn, [{ productId: 1, description: 's', field: 'product.1', nbs: nbs.code,
              classificationCode: code, placeIndicatorCode: place.code }], date, '2027-01-01')
            const v = await piece.classificationVerdictAt(conn, code, 'SE', date)
            if (saveOk) tally.saved++
            if (v.reason === 'cst-without-group') tally.refusedGroup++
            if (ev.declaration.group) tally.declared++
            if (ev.declaration.group && groupOf.get(code.slice(0, 3)) !== 'S') fails.push(`[${label}] ${code}@${date}: grupo CONGELADO com CST sem "S"`)
            if ((ev.declaration.group !== null) !== v.accepted) fails.push(`[${label}] ${code}@${date}: faturamento × veredito`)
          }
        }
      }
      await round('carga real')
      await raw.query(`UPDATE \`${S}\`.tb_tax_ibscbs SET requires_ibscbs_group = NULL WHERE id = '000'`)
      await round('000 NULL')
      await raw.query(`UPDATE \`${S}\`.tb_tax_ibscbs SET requires_ibscbs_group = 'N' WHERE id IN ('000', '200')`)
      await round('000/200 N')
    } finally {
      await raw.query(`DROP DATABASE IF EXISTS \`${S}\``).catch(() => undefined)
      raw.release()
      await pool.end()
    }
    expect(fails).toEqual([])
    // a matriz não passa no vazio: o IT 1.70 tem 173 cClassTrib; há aceitos, recusados pelo grupo e grupos congelados
    expect(tally.codes).toBeGreaterThan(150)
    expect(tally.saved).toBeGreaterThan(0)
    expect(tally.refusedGroup).toBeGreaterThan(0)
    expect(tally.declared).toBeGreaterThan(0)
  })
})
