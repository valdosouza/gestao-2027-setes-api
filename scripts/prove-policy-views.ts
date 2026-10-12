/**
 * PROVA DE EQUIVALÊNCIA dos leitores de POLÍTICA pelas views da 065 (F2a, etapa A2 — D-F32;
 * Infra-IA/prompts/prompt_apis_fiscais_isoladas.md §22.9). SOMENTE LEITURA.
 *
 * Até a A2 o setes-api tinha a regra em TS/SQL próprio e as views (lidas pela nfse-api e pelo núcleo) eram uma
 * 2ª cópia. A A2 troca os leitores do setes-api para as views; esta prova compara, nos dados reais, a regra ANTIGA
 * (copiada aqui do `main` anterior à A2, verbatim) com os leitores NOVOS:
 *
 * 1. Interface do ramo: para TODO id que exista em `tb_order`, `tb_service_order` ou `tb_order_stock_adjust_return`
 *    (terminal 0), `hasServiceOrderCycle` → `getAnchor(includeDeleted)` → 'orders' (antigo) × `resolveOrderInterface`
 *    (novo, pela `vw_order_interface`) — chamado UM A UM, o caminho de código de verdade.
 * 2. Último evento: para TODA nota (viva ou excluída, terminal 0), o `ORDER BY event DESC LIMIT 1` antigo (kind e
 *    event — o do `lockInvoice` e o do `LAST_INVOICE_EVENT_KIND_SQL`) × o `LAST_INVOICE_EVENT_KIND_SQL` novo e a
 *    linha da `vw_invoice_life` (a mesma consulta do `lockInvoice` novo, SEM a trava — nada de trava em produção).
 * 3. Devolução vigente: para TODO vínculo de devolução, o `CURRENT_RETURN_SQL` antigo × o novo.
 * 4. Fatos que a view não enxerga: eventos de nota sem cabeçalho em `tb_invoice` (a view parte da nota).
 * 5. Custo (D-F40): EXPLAIN das leituras novas (view fundida — sem DERIVED/MATERIALIZED, acesso por chave).
 *
 *   npx tsx --require tsconfig-paths/register scripts/prove-policy-views.ts
 * Sai com código 1 em qualquer divergência. Repetir em produção na F3 (Onda 4).
 */
import 'dotenv/config'
import pool from '../src/shared/db/connection'
import { resolveOrderInterface } from '../src/modules/billing/billing.interface-resolver'
import { LAST_INVOICE_EVENT_KIND_SQL } from '../src/shared/invoice/invoice'
import { CURRENT_RETURN_SQL } from '../src/shared/order-return/order-return'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---- regra ANTIGA (setes-api main 6bd6f83, verbatim nas condições) --------------------------------------------
const OLD_LAST_KIND_SQL = (s: string, alias = 'i') =>
  `(SELECT ev.kind FROM \`${s}\`.tb_invoice_event ev
     WHERE ev.tb_institution_id = ${alias}.tb_institution_id
       AND ev.tb_invoice_id = ${alias}.id AND ev.terminal = ${alias}.terminal
       AND ev.deleted = 'N'
     ORDER BY ev.event DESC LIMIT 1)`
const OLD_LAST_EVENT_SQL = (s: string, alias = 'i') =>
  `(SELECT ev.event FROM \`${s}\`.tb_invoice_event ev
     WHERE ev.tb_institution_id = ${alias}.tb_institution_id
       AND ev.tb_invoice_id = ${alias}.id AND ev.terminal = ${alias}.terminal
       AND ev.deleted = 'N'
     ORDER BY ev.event DESC LIMIT 1)`
const OLD_CURRENT_RETURN_SQL = (schema: string, retAlias = 'r') => `
      EXISTS (SELECT 1 FROM \`${schema}\`.tb_order adj
               WHERE adj.id = ${retAlias}.tb_order_id AND adj.tb_institution_id = ${retAlias}.tb_institution_id
                 AND adj.terminal = ${retAlias}.terminal AND adj.deleted = 'N')
      AND COALESCE((SELECT ev.kind FROM \`${schema}\`.tb_invoice_event ev
                     WHERE ev.tb_institution_id = ${retAlias}.tb_institution_id
                       AND ev.tb_invoice_id = ${retAlias}.tb_order_id
                       AND ev.terminal = ${retAlias}.terminal AND ev.deleted = 'N'
                     ORDER BY ev.event DESC LIMIT 1), 'E') <> 'C'`

async function oldInterface(s: string, inst: number, orderId: number): Promise<string> {
  const [so] = await pool.query<any[]>(
    `SELECT 1 FROM \`${s}\`.tb_service_order
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' LIMIT 1`, [orderId, inst])
  if (so.length) return 'service-orders'
  const [ra] = await pool.query<any[]>(
    `SELECT tb_order_id_ori FROM \`${s}\`.tb_order_stock_adjust_return
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0`, [orderId, inst])
  return ra.length ? 'order-returns' : 'orders'
}

async function proveSchema(s: string, inst: number): Promise<void> {
  console.log(`\n== ${s} (institution ${inst})`)

  // 1. interface do ramo
  const [ids] = await pool.query<any[]>(
    `SELECT id FROM \`${s}\`.tb_order WHERE tb_institution_id = ? AND terminal = 0
     UNION SELECT id FROM \`${s}\`.tb_service_order WHERE tb_institution_id = ? AND terminal = 0
     UNION SELECT id FROM \`${s}\`.tb_order_stock_adjust_return WHERE tb_institution_id = ? AND terminal = 0`,
    [inst, inst, inst])
  const byKey: Record<string, number> = {}
  const diverge: string[] = []
  for (const { id } of ids) {
    const [a, b] = [await oldInterface(s, inst, Number(id)), await resolveOrderInterface(s, inst, Number(id))]
    byKey[b] = (byKey[b] ?? 0) + 1
    if (a !== b) diverge.push(`${id}: ${a} → ${b}`)
  }
  for (const id of [0, -1, 999999999]) {
    const b = await resolveOrderInterface(s, inst, id)
    if (b !== 'orders') diverge.push(`${id}: orders → ${b}`)
  }
  check(`interface do ramo — ${ids.length} pedidos (${Object.entries(byKey).map(([k, n]) => `${k}=${n}`).join(' ')})`,
    diverge.length === 0, diverge.slice(0, 10).join('; '))
  const [orphanBranch] = await pool.query<any[]>(
    `SELECT (SELECT COUNT(*) FROM \`${s}\`.tb_service_order so WHERE so.tb_institution_id = ? AND so.terminal = 0 AND so.deleted = 'N'
              AND NOT EXISTS (SELECT 1 FROM \`${s}\`.tb_order o WHERE o.id = so.id AND o.tb_institution_id = so.tb_institution_id AND o.terminal = so.terminal)) AS so,
            (SELECT COUNT(*) FROM \`${s}\`.tb_order_stock_adjust_return ra WHERE ra.tb_institution_id = ? AND ra.terminal = 0
              AND NOT EXISTS (SELECT 1 FROM \`${s}\`.tb_order o WHERE o.id = ra.id AND o.tb_institution_id = ra.tb_institution_id AND o.terminal = ra.terminal)) AS ra`,
    [inst, inst])
  check('ramo sem pedido em tb_order (a view parte do pedido)', Number(orphanBranch[0].so) + Number(orphanBranch[0].ra) === 0,
    `OS órfã ${orphanBranch[0].so} · âncora órfã ${orphanBranch[0].ra}`)

  // 2. último evento (kind e event) e vida
  const [inv] = await pool.query<any[]>(
    `SELECT i.id,
            ${OLD_LAST_KIND_SQL(s, 'i')} AS oldKind, ${OLD_LAST_EVENT_SQL(s, 'i')} AS oldEvent,
            ${LAST_INVOICE_EVENT_KIND_SQL(s, 'i')} AS newKind,
            l.last_kind AS viewKind, l.last_event AS viewEvent, l.life_event AS lifeEvent,
            (SELECT MAX(ev.event) FROM \`${s}\`.tb_invoice_event ev
              WHERE ev.tb_institution_id = i.tb_institution_id AND ev.tb_invoice_id = i.id AND ev.terminal = i.terminal
                AND ev.kind = 'E' AND ev.deleted = 'N') AS oldLife
       FROM \`${s}\`.tb_invoice i
       LEFT JOIN \`${s}\`.vw_invoice_life l
         ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = i.terminal
      WHERE i.tb_institution_id = ? AND i.terminal = 0`, [inst])
  const kinds: Record<string, number> = {}
  const dk: string[] = []
  let withLife = 0
  for (const r of inv) {
    kinds[String(r.newKind ?? 'NULL')] = (kinds[String(r.newKind ?? 'NULL')] ?? 0) + 1
    if (r.lifeEvent != null) withLife++
    const same = (r.oldKind ?? null) === (r.newKind ?? null) && (r.oldKind ?? null) === (r.viewKind ?? null)
      && (r.oldEvent == null ? null : Number(r.oldEvent)) === (r.viewEvent == null ? null : Number(r.viewEvent))
      && (r.oldLife == null ? null : Number(r.oldLife)) === (r.lifeEvent == null ? null : Number(r.lifeEvent))
    if (!same) dk.push(`${r.id}: ${r.oldKind}/${r.oldEvent}/${r.oldLife} → ${r.newKind}|${r.viewKind}/${r.viewEvent}/${r.lifeEvent}`)
  }
  check(`último evento e vida — ${inv.length} notas (${Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(' ')}; com vida ${withLife})`,
    dk.length === 0, dk.slice(0, 10).join('; '))
  const [orphanEv] = await pool.query<any[]>(
    `SELECT COUNT(DISTINCT ev.tb_invoice_id) AS n FROM \`${s}\`.tb_invoice_event ev
      WHERE ev.tb_institution_id = ? AND ev.deleted = 'N'
        AND NOT EXISTS (SELECT 1 FROM \`${s}\`.tb_invoice i
                         WHERE i.id = ev.tb_invoice_id AND i.tb_institution_id = ev.tb_institution_id AND i.terminal = ev.terminal)`,
    [inst])
  check('eventos sem cabeçalho em tb_invoice (a view parte da nota)', Number(orphanEv[0].n) === 0, `${orphanEv[0].n} nota(s)`)

  // 3. devolução vigente
  const [ret] = await pool.query<any[]>(
    `SELECT r.tb_order_id AS orderId, r.id AS itemId,
            (${OLD_CURRENT_RETURN_SQL(s, 'r')}) AS oldCur, (${CURRENT_RETURN_SQL(s, 'r')}) AS newCur
       FROM \`${s}\`.tb_order_item_return r
      WHERE r.tb_institution_id = ?`, [inst])
  const dr = ret.filter(r => Number(r.oldCur) !== Number(r.newCur)).map(r => `${r.orderId}/${r.itemId}: ${r.oldCur} → ${r.newCur}`)
  const vig = ret.filter(r => Number(r.newCur) === 1).length
  check(`devolução vigente — ${ret.length} vínculos (vigentes ${vig})`, dr.length === 0, dr.slice(0, 10).join('; '))

  // 5. custo (D-F40)
  const plans: Array<[string, string, unknown[]]> = [
    ['resolveOrderInterface', `SELECT interface_key FROM \`${s}\`.vw_order_interface WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0`, [inst, 1]],
    ['lockInvoice (vida)', `SELECT life_event, last_event, last_kind FROM \`${s}\`.vw_invoice_life WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0`, [inst, 1]],
    ['LAST_INVOICE_EVENT_KIND_SQL numa lista',
      `SELECT i.id, ${LAST_INVOICE_EVENT_KIND_SQL(s, 'i')} AS k FROM \`${s}\`.tb_invoice i WHERE i.tb_institution_id = ? AND i.terminal = 0 LIMIT 50`, [inst]],
    ['CURRENT_RETURN_SQL',
      `SELECT r.id FROM \`${s}\`.tb_order_item_return r WHERE r.tb_institution_id = ? AND r.tb_order_id_ori = ? AND r.deleted = 'N' AND ${CURRENT_RETURN_SQL(s, 'r')}`, [inst, 1]],
  ]
  for (const [label, sql, params] of plans) {
    const [ex] = await pool.query<any[]>(`EXPLAIN ${sql}`, params)
    const bad = ex.filter(r => /DERIVED|MATERIALIZED/i.test(String(r.select_type)) || (r.type === 'ALL' && !/^i$|^r$/.test(String(r.table))))
    check(`EXPLAIN ${label}`, bad.length === 0, ex.map(r => `${r.id}/${r.select_type}/${r.table}/${r.type}/${r.key ?? '-'}`).join(' '))
  }
}

async function main(): Promise<void> {
  const [insts] = await pool.query<any[]>(
    `SELECT id, schema_name AS s FROM setes_central.tb_institution WHERE deleted = 'N' AND active = 'S' ORDER BY id`)
  for (const r of insts) await proveSchema(String(r.s), Number(r.id))
  console.log(`\n${failures ? `${failures} FALHA(S)` : 'equivalência provada — zero divergência'}`)
}

main()
  .then(() => pool.end().then(() => process.exit(failures ? 1 : 0)))
  .catch(async err => { console.error('ERRO', err); await pool.end(); process.exit(1) })
