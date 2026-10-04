/**
 * PROVA DE EQUIVALÊNCIA da forma de LISTA da peça do saldo (D-BA37 — Onda 3 da pesquisa avançada,
 * Infra-IA/prompts/prompt_pesquisa_avancada.md §13; parecer do guardião). SOMENTE LEITURA.
 *
 * 1. Fórmula: para TODOS os títulos de cada institution do schema (inclusive excluídos e qualquer
 *    terminal), principal e saldo pela forma correlacionada (`PRINCIPAL_PAID_SQL`/`OPEN_BALANCE_SQL`)
 *    × pela forma de lista (`PRINCIPAL_PAID_JOIN_SQL` + `_OF`) — comparação DENTRO do SQL com `<=>`
 *    em DECIMAL (nunca em JS: decimalNumbers vira float). Esperado: 0 divergências.
 * 2. Lista: a `listBills` nova × a lista ANTIGA (HAVING sobre a forma correlacionada, reconstruída
 *    aqui) — mesmo total e mesmas linhas, na mesma ordem, na 1ª e na última página, para as abas
 *    open/settled/todas, combinadas com filtro de texto e com `kind`. Sem fan-out: total da aba
 *    "todas" = COUNT(*) de tb_financial × bills com o mesmo WHERE.
 * 3. Casos presentes nos dados (a prova só vale para o que existe): sem baixa, só estornada (E+R),
 *    parcial, com desconto, com juros/multa, baixa excluída, paid_value NULL, terminal ≠ 0.
 * 4. Critério de saldo: na aba "todas", faixa 0..0 + aba Abertos = total.
 * 5. Tempos antes × depois (D-BA44).
 *
 *   npx tsx --require tsconfig-paths/register scripts/prove-title-balance-list.ts
 * Sai com código 1 em qualquer divergência. Repetir em produção na Onda 4.
 */
import 'dotenv/config'
import pool from '../src/shared/db/connection'
import { compileCriteria, escapeLike, ListQuery, NO_CRITERIA } from '../src/shared/list'
import {
  OPEN_BALANCE_SQL, PRINCIPAL_PAID_SQL, PRINCIPAL_PAID_JOIN_SQL, PRINCIPAL_PAID_OF, OPEN_BALANCE_OF,
} from '../src/shared/financial-settlement/title-balance'
import { listBills, BILL_SEARCH_CRITERIA } from '../src/modules/settlements/settlements.repository'

const S = process.env.PROVE_SCHEMA ?? 'setes_setes'
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const ENTITY_JOINS = `
     LEFT JOIN \`${S}\`.tb_order_service osv
        ON osv.id = f.tb_order_id AND osv.tb_institution_id = f.tb_institution_id AND osv.terminal = f.terminal
     LEFT JOIN \`${S}\`.tb_order_financial ofn
        ON ofn.id = f.tb_order_id AND ofn.tb_institution_id = f.tb_institution_id AND ofn.terminal = f.terminal
     LEFT JOIN setes_central.tb_entity e ON e.id = COALESCE(osv.tb_customer_id, ofn.tb_entity_id)`

/** A lista ANTIGA (antes da D-BA37): HAVING sobre a forma correlacionada; COUNT envolvendo o SELECT. */
async function oldList(status: 'open' | 'settled' | '', kind: string, filter: string, page: number, pageSize: number, inst: number) {
  const like = filter ? `%${escapeLike(filter)}%` : null
  const kindFilter = kind || null
  const having = status === 'open' ? 'HAVING balance > 0' : status === 'settled' ? 'HAVING paidValue > 0' : ''
  const where = `FROM \`${S}\`.tb_financial f
     INNER JOIN \`${S}\`.tb_financial_bills b
        ON b.tb_institution_id = f.tb_institution_id AND b.tb_order_id = f.tb_order_id
       AND b.terminal = f.terminal AND b.parcel = f.parcel AND b.deleted = 'N'
     ${ENTITY_JOINS}
     LEFT JOIN setes_central.tb_payment_types pt ON pt.id = f.tb_payment_types_id
     WHERE f.tb_institution_id = ? AND f.deleted = 'N'
       AND (? IS NULL OR b.kind = ?)
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR b.number LIKE ?)`
  const params = [inst, kindFilter, kindFilter, like, like, like, like]
  const [rows] = await pool.query<any[]>(
    `SELECT f.tb_order_id AS orderId, f.parcel,
            ${PRINCIPAL_PAID_SQL(S, 'f')} AS paidValue, ${OPEN_BALANCE_SQL(S, 'f')} AS balance
     ${where} ${having}
     ORDER BY f.dt_expiration, f.tb_order_id, f.parcel LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize])
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total FROM (SELECT ${PRINCIPAL_PAID_SQL(S, 'f')} AS paidValue, ${OPEN_BALANCE_SQL(S, 'f')} AS balance
       ${where} ${having}) t`, params)
  return { rows, total: Number(count[0].total) }
}

const q = (page: number, pageSize: number, filter = '', criteria = NO_CRITERIA): ListQuery =>
  ({ filter, page, pageSize, offset: (page - 1) * pageSize, criteria })
const keys = (rows: any[]) => rows.map(r => `${r.orderId}/${r.parcel}:${r.balance}:${r.paidValue}`).join(',')

async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
  await f()   // aquece
  const t0 = Date.now(); let r!: T
  for (let i = 0; i < 3; i++) r = await f()
  return [r, Math.round((Date.now() - t0) / 3)]
}

async function main(): Promise<void> {
  const [insts] = await pool.query<any[]>(`SELECT DISTINCT tb_institution_id AS i FROM \`${S}\`.tb_financial`)
  console.log(`schema ${S} · institutions com título: ${insts.map(r => r.i).join(', ')}`)

  // 1 + 3. fórmula e casos, por institution
  for (const { i: inst } of insts) {
    const [[r]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n,
              SUM(NOT (${PRINCIPAL_PAID_SQL(S, 'f')} <=> ${PRINCIPAL_PAID_OF('pp')})) AS divPrincipal,
              SUM(NOT (${OPEN_BALANCE_SQL(S, 'f')} <=> ${OPEN_BALANCE_OF('f', 'pp')})) AS divBalance
         FROM \`${S}\`.tb_financial f ${PRINCIPAL_PAID_JOIN_SQL(S, 'f', 'pp')}
        WHERE f.tb_institution_id = ?`, [inst, inst])
    check(`institution ${inst}: principal correlacionado = agregado em ${r.n} títulos (inclui excluídos e todo terminal)`, Number(r.divPrincipal) === 0, `divergências=${r.divPrincipal}`)
    check(`institution ${inst}: saldo correlacionado = agregado`, Number(r.divBalance) === 0, `divergências=${r.divBalance}`)
    const [[c]] = await pool.query<any[]>(
      `SELECT
         SUM(NOT EXISTS (SELECT 1 FROM \`${S}\`.tb_financial_payment p WHERE p.tb_institution_id=f.tb_institution_id AND p.tb_order_id=f.tb_order_id AND p.terminal=f.terminal AND p.parcel=f.parcel)) AS semBaixa,
         SUM(EXISTS (SELECT 1 FROM \`${S}\`.tb_financial_payment p WHERE p.tb_institution_id=f.tb_institution_id AND p.tb_order_id=f.tb_order_id AND p.terminal=f.terminal AND p.parcel=f.parcel AND p.status='E')
             AND NOT EXISTS (SELECT 1 FROM \`${S}\`.tb_financial_payment p WHERE p.tb_institution_id=f.tb_institution_id AND p.tb_order_id=f.tb_order_id AND p.terminal=f.terminal AND p.parcel=f.parcel AND p.status='N' AND p.deleted='N')) AS soEstornada,
         SUM(${PRINCIPAL_PAID_OF('pp')} > 0 AND ${OPEN_BALANCE_OF('f', 'pp')} > 0) AS parcial,
         SUM(EXISTS (SELECT 1 FROM \`${S}\`.tb_financial_payment p WHERE p.tb_institution_id=f.tb_institution_id AND p.tb_order_id=f.tb_order_id AND p.terminal=f.terminal AND p.parcel=f.parcel AND COALESCE(p.discount_value,0) > 0)) AS comDesconto,
         SUM(EXISTS (SELECT 1 FROM \`${S}\`.tb_financial_payment p WHERE p.tb_institution_id=f.tb_institution_id AND p.tb_order_id=f.tb_order_id AND p.terminal=f.terminal AND p.parcel=f.parcel AND (COALESCE(p.interest_value,0) > 0 OR COALESCE(p.late_value,0) > 0))) AS comJurosMulta,
         SUM(EXISTS (SELECT 1 FROM \`${S}\`.tb_financial_payment p WHERE p.tb_institution_id=f.tb_institution_id AND p.tb_order_id=f.tb_order_id AND p.terminal=f.terminal AND p.parcel=f.parcel AND p.deleted='Y')) AS baixaExcluida,
         SUM(EXISTS (SELECT 1 FROM \`${S}\`.tb_financial_payment p WHERE p.tb_institution_id=f.tb_institution_id AND p.tb_order_id=f.tb_order_id AND p.terminal=f.terminal AND p.parcel=f.parcel AND p.paid_value IS NULL)) AS paidNulo,
         SUM(f.terminal <> 0) AS terminalNaoZero,
         SUM(f.deleted <> 'N') AS tituloExcluido
       FROM \`${S}\`.tb_financial f ${PRINCIPAL_PAID_JOIN_SQL(S, 'f', 'pp')}
      WHERE f.tb_institution_id = ?`, [inst, inst])
    console.log(`  casos presentes (institution ${inst}): ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  }

  const inst = Number(insts[0].i)
  // 2. lista antiga × nova
  const pageSize = 25
  for (const status of ['open', 'settled', ''] as const) {
    for (const [kind, filter] of [['', ''], ['RA', ''], ['', 'a'], ['PA', 'a']] as const) {
      const label = `aba=${status || 'todas'} kind=${kind || '-'} filtro=${filter || '-'}`
      const oldFirst = await oldList(status, kind, filter, 1, pageSize, inst)
      const newFirst = await listBills(status, kind, q(1, pageSize, filter), S, inst)
      const lastPage = Math.max(1, Math.ceil(oldFirst.total / pageSize))
      const oldLast = await oldList(status, kind, filter, lastPage, pageSize, inst)
      const newLast = await listBills(status, kind, q(lastPage, pageSize, filter), S, inst)
      check(`${label}: total igual`, oldFirst.total === newFirst.total, `${oldFirst.total} × ${newFirst.total}`)
      check(`${label}: 1ª página idêntica (ids, saldo, principal, ordem)`, keys(oldFirst.rows) === keys(newFirst.rows))
      check(`${label}: última página (${lastPage}) idêntica`, keys(oldLast.rows) === keys(newLast.rows))
    }
  }
  const [[all]] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n FROM \`${S}\`.tb_financial f
       INNER JOIN \`${S}\`.tb_financial_bills b ON b.tb_institution_id = f.tb_institution_id AND b.tb_order_id = f.tb_order_id
        AND b.terminal = f.terminal AND b.parcel = f.parcel AND b.deleted = 'N'
      WHERE f.tb_institution_id = ? AND f.deleted = 'N'`, [inst])
  const allNew = await listBills('', '', q(1, 1), S, inst)
  check('sem fan-out: total da aba "todas" = COUNT(*) de títulos × bills', allNew.total === Number(all.n), `${allNew.total} × ${all.n}`)

  // 4. critério de saldo
  const zero = await listBills('', '', q(1, 1, '', compileCriteria(JSON.stringify({ balance: { from: 0, to: 0 } }), BILL_SEARCH_CRITERIA)), S, inst)
  const open = await listBills('open', '', q(1, 1), S, inst)
  check('critério saldo: faixa 0..0 + aba Abertos = todas', zero.total + open.total === allNew.total, `${zero.total} + ${open.total} = ${allNew.total}`)
  const fromCent = await listBills('open', '', q(1, 1, '', compileCriteria(JSON.stringify({ balance: { from: 0.01 } }), BILL_SEARCH_CRITERIA)), S, inst)
  check('critério saldo: "a partir de 0,01" na aba Abertos = a própria aba', fromCent.total === open.total, `${fromCent.total} = ${open.total}`)

  // 5. tempos antes × depois
  console.log('\n— tempos (média de 3, após aquecer) — D-BA44')
  for (const status of ['open', ''] as const) {
    const [o, tOld] = await timed(() => oldList(status, '', '', 1, pageSize, inst))
    const [n, tNew] = await timed(() => listBills(status, '', q(1, pageSize), S, inst))
    const last = Math.max(1, Math.ceil(o.total / pageSize))
    const [, tOldLast] = await timed(() => oldList(status, '', '', last, pageSize, inst))
    const [, tNewLast] = await timed(() => listBills(status, '', q(last, pageSize), S, inst))
    console.log(`  aba ${status || 'todas'} (${n.total}): página 1 ${tOld} → ${tNew} ms · última ${tOldLast} → ${tNewLast} ms`)
  }
  const crit = compileCriteria(JSON.stringify({ balance: { from: 100, to: 500 } }), BILL_SEARCH_CRITERIA)
  const [cb, tCrit] = await timed(() => listBills('open', '', q(1, pageSize, '', crit), S, inst))
  console.log(`  aba open + saldo 100..500 (${cb.total}): ${tCrit} ms`)
  const [[ent]] = await pool.query<any[]>(`SELECT COALESCE(osv.tb_customer_id, ofn.tb_entity_id) AS id FROM \`${S}\`.tb_financial f ${ENTITY_JOINS} WHERE f.tb_institution_id = ? AND f.deleted = 'N' LIMIT 1`, [inst])
  const critE = compileCriteria(JSON.stringify({ entity: ent.id }), BILL_SEARCH_CRITERIA)
  const [ce, tEnt] = await timed(() => listBills('open', '', q(1, pageSize, '', critE), S, inst))
  console.log(`  aba open + entidade ${ent.id} (${ce.total}): ${tEnt} ms`)

  console.log(`\n${failures ? 'REPROVADO' : 'APROVADO'}: ${failures} falha(s)`)
  await pool.end()
  process.exit(failures ? 1 : 0)
}

main().catch(async err => { console.error('ERRO:', err?.message ?? err); await pool.end().catch(() => undefined); process.exit(1) })
