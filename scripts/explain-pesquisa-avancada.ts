/**
 * M5 da PESQUISA AVANÇADA (Infra-IA/prompts/prompt_pesquisa_avancada.md §9.1 e §12.3,
 * D-BA28 — Valdo 2026-10-03: medir ANTES de levar critérios às demais telas). SOMENTE LEITURA.
 *
 * Para cada lista branca registrada em TARGETS, chama a função de lista REAL do módulo
 * (o SQL é capturado interceptando pool.query — nada é duplicado aqui), com TODOS os
 * critérios preenchidos com valores de amostra e depois com cada critério sozinho, e roda
 * `EXPLAIN` da página e do COUNT.
 *
 * Regra (D-BA11): expressão sobre outra tabela é subselect correlacionado — ele roda UMA
 * vez por linha candidata, então a tabela dele TEM de chegar por chave (`eq_ref`/`ref`/
 * `const`/`unique_subquery`). Linha `DEPENDENT SUBQUERY` com `type = ALL` (ou `index`) =
 * varredura por linha = índice faltando → migration na MESMA entrega. A tabela que dirige a
 * consulta pode varrer (catálogo pequeno) — sai como AVISO, não como falha.
 *
 *   npx tsx --require tsconfig-paths/register scripts/explain-pesquisa-avancada.ts [modulo]
 * Sai com código 1 se houver FALHA. Toda lista branca nova entra em TARGETS (cerca permanente).
 */
import 'dotenv/config'
import pool from '../src/shared/db/connection'
import { compileCriteria, ListQuery, SearchCriterion } from '../src/shared/list'
import { CUSTOMER_SEARCH_CRITERIA, listCustomers } from '../src/modules/customers/customers.repository'
import {
  SERVICE_ORDER_SEARCH_CRITERIA, listOrders,
} from '../src/modules/service-orders/service-orders.repository'
import { CARRIER_SEARCH_CRITERIA, listCarriers } from '../src/modules/carriers/carriers.repository'
import { COLLABORATOR_SEARCH_CRITERIA, listCollaborators } from '../src/modules/collaborators/collaborators.repository'
import { PROVIDER_SEARCH_CRITERIA, listProviders } from '../src/modules/providers/providers.repository'
import { SALESMAN_SEARCH_CRITERIA, listSalesmen } from '../src/modules/salesmen/salesmen.repository'
import { INSTITUTION_SEARCH_CRITERIA, listInstitutions } from '../src/modules/institutions/institutions.repository'
import { BANK_ACCOUNT_SEARCH_CRITERIA, listBankAccounts } from '../src/modules/bank-accounts/bank-accounts.repository'
import {
  CHARGE_AGREEMENT_SEARCH_CRITERIA, listChargeAgreements,
} from '../src/modules/bank-charge-agreements/bank-charge-agreements.repository'
import {
  SETTLEMENT_RULE_SEARCH_CRITERIA, listSettlementRules,
} from '../src/modules/settlement-rules/settlement-rules.repository'
import { PAYMENT_TYPE_SEARCH_CRITERIA, listLinked } from '../src/modules/payment-types/payment-types.repository'
import { PRICE_LIST_SEARCH_CRITERIA, listPriceLists } from '../src/modules/price-lists/price-lists.repository'
import { SERVICE_SEARCH_CRITERIA, listServices } from '../src/modules/services/services.repository'
import { USER_SEARCH_CRITERIA, listUsers } from '../src/modules/users/users.repository'
import { CONTRACT_SEARCH_CRITERIA, listContracts } from '../src/modules/contracts/contracts.repository'

const SCHEMA = process.env.EXPLAIN_SCHEMA ?? 'setes_setes'
const INST   = Number(process.env.EXPLAIN_INSTITUTION ?? 1)
const ZONE   = 'America/Sao_Paulo'

interface Target {
  module: string
  defs:   readonly SearchCriterion[]
  /** chama a lista REAL do módulo com a query montada aqui */
  run:    (q: ListQuery) => Promise<unknown>
  /** tabelas-base (volume do ambiente, só informativo) */
  base:   string[]
}

const TARGETS: Target[] = [
  { module: 'customers', defs: CUSTOMER_SEARCH_CRITERIA,
    run: q => listCustomers(q, SCHEMA, INST, null), base: [`${SCHEMA}.tb_customer`] },
  { module: 'service-orders', defs: SERVICE_ORDER_SEARCH_CRITERIA,
    run: q => listOrders('', q, SCHEMA, INST), base: [`${SCHEMA}.tb_order_service`] },
  // --- Onda 2, Bloco 1 (§12.1)
  { module: 'carriers', defs: CARRIER_SEARCH_CRITERIA,
    run: q => listCarriers(q, SCHEMA, INST), base: [`${SCHEMA}.tb_carrier`] },
  { module: 'collaborators', defs: COLLABORATOR_SEARCH_CRITERIA,
    run: q => listCollaborators(q, SCHEMA, INST), base: [`${SCHEMA}.tb_collaborator`] },
  { module: 'providers', defs: PROVIDER_SEARCH_CRITERIA,
    run: q => listProviders(q, SCHEMA, INST), base: [`${SCHEMA}.tb_provider`] },
  { module: 'salesmen', defs: SALESMAN_SEARCH_CRITERIA,
    run: q => listSalesmen(q, SCHEMA, INST), base: [`${SCHEMA}.tb_salesman`] },
  { module: 'institutions', defs: INSTITUTION_SEARCH_CRITERIA,
    run: q => listInstitutions(q), base: ['setes_central.tb_institution'] },
  { module: 'bank-accounts', defs: BANK_ACCOUNT_SEARCH_CRITERIA,
    run: q => listBankAccounts(q, SCHEMA, INST), base: [`${SCHEMA}.tb_bank_account`] },
  { module: 'bank-charge-agreements', defs: CHARGE_AGREEMENT_SEARCH_CRITERIA,
    run: q => listChargeAgreements(q, SCHEMA, INST), base: [`${SCHEMA}.tb_bank_charge_agreement`] },
  { module: 'settlement-rules', defs: SETTLEMENT_RULE_SEARCH_CRITERIA,
    run: q => listSettlementRules(q, SCHEMA, INST), base: [`${SCHEMA}.tb_settlement_rule`] },
  { module: 'payment-types', defs: PAYMENT_TYPE_SEARCH_CRITERIA,
    run: q => listLinked(q, SCHEMA, INST), base: [`${SCHEMA}.tb_institution_has_payment_types`] },
  { module: 'price-lists', defs: PRICE_LIST_SEARCH_CRITERIA,
    run: q => listPriceLists(q, SCHEMA, INST), base: [`${SCHEMA}.tb_price_list`] },
  { module: 'services', defs: SERVICE_SEARCH_CRITERIA,
    run: q => listServices(q, SCHEMA, INST), base: [`${SCHEMA}.tb_product`] },
  { module: 'users', defs: USER_SEARCH_CRITERIA,
    run: q => listUsers(q, INST), base: ['setes_central.tb_user', 'setes_central.tb_institution_has_user'] },
  { module: 'contracts', defs: CONTRACT_SEARCH_CRITERIA,
    run: q => listContracts(q, SCHEMA, INST), base: [`${SCHEMA}.tb_contract`, `${SCHEMA}.tb_contract_item`] },
]

// --- valores de amostra por kind (só precisam COMPILAR; o plano não depende do valor)
function sampleFor(def: SearchCriterion): unknown {
  switch (def.kind) {
    case 'text':    return def.digits ? '12345678' : 'a'
    case 'number':  return { from: 1, to: 10 }
    case 'money':   return { from: 1, to: 1000 }
    case 'date':    return { from: '2026-01-01', to: '2026-12-31' }
    case 'lookup':  return 1
    case 'options': return [def.options![0]]
    case 'bool':    return true
  }
}

// --- captura do SQL real do módulo
type Captured = { sql: string; params: unknown[] }
const realQuery = pool.query.bind(pool) as (sql: string, params?: unknown[]) => Promise<any>
let captured: Captured[] = []
;(pool as any).query = async (sql: string, params?: unknown[]) => {
  captured.push({ sql, params: params ?? [] })
  return realQuery(sql, params)
}

function queryOf(defs: readonly SearchCriterion[], values: Record<string, unknown>): ListQuery {
  return {
    filter: '', page: 1, pageSize: 25, offset: 0,
    criteria: compileCriteria(JSON.stringify(values), defs, ZONE),
  }
}

interface ExplainRow {
  id: number; select_type: string; table: string | null; type: string | null
  key: string | null; rows: number | null; Extra: string | null
}

const SCAN = new Set(['ALL', 'index'])
const PER_ROW = /DEPENDENT|UNCACHEABLE/

let failures = 0
let warnings = 0

async function explainOne(label: string, c: Captured): Promise<void> {
  const [rows] = await realQuery(`EXPLAIN ${c.sql}`, c.params) as [ExplainRow[]]
  for (const r of rows) {
    const scan = r.type !== null && SCAN.has(r.type)
    const perRow = PER_ROW.test(r.select_type)
    const mark = scan && perRow ? 'FALHA' : scan ? 'aviso' : 'ok   '
    if (scan && perRow) failures++
    else if (scan) warnings++
    console.log(`  ${mark} ${label.padEnd(10)} ${String(r.id).padStart(2)} ${r.select_type.padEnd(20)} ` +
      `${String(r.table ?? '-').padEnd(14)} ${String(r.type ?? '-').padEnd(8)} key=${r.key ?? '-'} ` +
      `rows=${r.rows ?? '-'}${r.Extra ? `  [${r.Extra}]` : ''}`)
  }
}

async function runTarget(t: Target): Promise<void> {
  console.log(`\n=== ${t.module} — ${t.defs.length} critérios`)
  for (const b of t.base) {
    const [[v]] = await realQuery(`SELECT COUNT(*) AS n FROM ${b}`)
    console.log(`  volume ${b}: ${v.n}`)
  }
  const cases: [string, Record<string, unknown>][] = [
    ['TODOS', Object.fromEntries(t.defs.map(d => [d.key, sampleFor(d)]))],
    ...t.defs.map(d => [d.key, { [d.key]: sampleFor(d) }] as [string, Record<string, unknown>]),
  ]
  for (const [label, values] of cases) {
    captured = []
    await t.run(queryOf(t.defs, values))
    if (captured.length !== 2) {
      failures++
      console.log(`  FALHA ${label}: esperava 2 consultas (página + COUNT), capturou ${captured.length}`)
      continue
    }
    console.log(`  -- ${label}`)
    await explainOne('página', captured[0])
    await explainOne('COUNT', captured[1])
  }
}

async function main(): Promise<void> {
  const only = process.argv[2]
  const targets = only ? TARGETS.filter(t => t.module === only) : TARGETS
  if (!targets.length) { console.error(`módulo desconhecido: ${only}`); process.exit(2) }
  const [[v]] = await realQuery(`SELECT VERSION() AS v`)
  console.log(`MySQL/MariaDB ${v.v} · schema ${SCHEMA} · institution ${INST}`)
  for (const t of targets) await runTarget(t)
  console.log(`\n${failures ? 'REPROVADO' : 'APROVADO'}: ${failures} falha(s) (varredura POR LINHA em subselect correlacionado), ` +
    `${warnings} aviso(s) (varredura ÚNICA: tabela que dirige ou derived table — aceitável em catálogo pequeno)`)
  await pool.end()
  process.exit(failures ? 1 : 0)
}

main().catch(async err => {
  console.error('ERRO:', err?.message ?? err)
  await pool.end().catch(() => undefined)
  process.exit(1)
})
