// =====================================================================
// Correção de dado — nota com REGISTRO FISCAL cancelada pelo caminho da nota
// PENDENTE (antes da correção D3/D4 de 2026-09-29, prompt_cancelamento_nota §15).
//
// O cancelamento fiscal reaproveitava o caminho da nota pendente: soft-deletava
// a nota, os ramos e os snapshots por item, devolvia o pedido a 'A' e reabria a
// OS. Pela D3/D4 (Valdo) a nota autorizada e cancelada FICA (evento C, número
// mantido) e o pedido vira 'C'. Este script leva UM pedido ao estado correto,
// tocando SÓ as linhas carimbadas pelo próprio cancelamento (updated_at = hora
// do evento C) — nada editado depois é tocado; se algo foi, ele PARA.
//
// Pré-condições conferidas (qualquer falha = aborta sem gravar):
//   - último evento da nota = C, e a transmissão vigente DETÉM a chave do fisco;
//   - nota soft-deletada no mesmo instante do evento C;
//   - pedido em 'A' e OS (se houver) sem item novo/alterado depois do C.
//
// Efeitos (uma transação): nota + ramos + snapshots do instante do C revivem;
// pedido → 'C'; OS → trava D5 solta (open_lock NULL); competências da OS
// devolvidas ao contrato (Q-CA2). Financeiro fica desfeito (D6 vale nos dois).
//
// Uso: npx tsx scripts/repair-authorized-cancel.ts <schema> <orderId>          (simulação)
//      npx tsx scripts/repair-authorized-cancel.ts <schema> <orderId> --apply  (grava)
// =====================================================================
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

const SNAPSHOT_TABLES = [
  'tb_order_item_icms', 'tb_order_item_icms_fcp', 'tb_order_item_ipi', 'tb_order_item_ii',
  'tb_order_item_pis', 'tb_order_item_cofins', 'tb_order_item_issqn',
]

async function main() {
  const [schema, idArg, flag] = process.argv.slice(2)
  if (!schema || !/^setes_[a-z0-9_]+$/.test(schema) || !/^\d+$/.test(idArg ?? '')) {
    throw new Error('uso: npx tsx scripts/repair-authorized-cancel.ts <schema setes_*> <orderId> [--apply]')
  }
  const orderId = Number(idArg)
  const apply = flag === '--apply'
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, charset: 'utf8mb4',
  })
  const s = `\`${schema}\``
  const q = async (sql: string, params: unknown[] = []) => (await conn.query<any[]>(sql, params))[0] as any
  try {
    await conn.beginTransaction()
    const inst = (await q(`SELECT tb_institution_id AS i FROM ${s}.tb_order WHERE id = ? AND terminal = 0 FOR UPDATE`, [orderId]))[0]?.i
    if (inst == null) throw new Error(`Pedido ${orderId} não existe em ${schema}`)

    const ev = (await q(`SELECT event, kind, created_at AS at FROM ${s}.tb_invoice_event
                          WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND deleted = 'N'
                          ORDER BY event DESC LIMIT 1`, [inst, orderId]))[0]
    if (ev?.kind !== 'C') throw new Error(`Último evento da nota ${orderId} não é C (${ev?.kind ?? 'nenhum'}) — nada a corrigir`)
    const at = ev.at as Date

    const keyed = (await q(`SELECT attempt, access_key FROM ${s}.tb_invoice_service_transmission
                             WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND deleted = 'N'
                               AND access_key IS NOT NULL AND environment = 'P' ORDER BY attempt DESC LIMIT 1`, [inst, orderId]))[0]
    // Q-CA5: só chave de PRODUÇÃO é registro fiscal — homologação cancelada segue o caminho da pendente
    if (!keyed) throw new Error(`Nota ${orderId} sem chave do fisco em PRODUÇÃO — é PENDENTE (Q-CA5), o soft-delete está correto`)

    const inv = (await q(`SELECT deleted, updated_at AS at FROM ${s}.tb_invoice
                           WHERE id = ? AND tb_institution_id = ? AND terminal = 0 FOR UPDATE`, [orderId, inst]))[0]
    if (inv?.deleted !== 'S' || +new Date(inv.at) !== +at) {
      throw new Error(`Nota ${orderId} não está no estado do cancelamento antigo (deleted=${inv?.deleted}, updated_at=${inv?.at}) — nada a corrigir`)
    }
    const ord = (await q(`SELECT status FROM ${s}.tb_order WHERE id = ? AND tb_institution_id = ? AND terminal = 0`, [orderId, inst]))[0]
    if (ord.status !== 'A') throw new Error(`Pedido ${orderId} em '${ord.status}' — esperado 'A' (reaberto pelo cancelamento antigo)`)
    const touched = (await q(`SELECT COUNT(*) AS n FROM ${s}.tb_order_item
                               WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0 AND updated_at > ?`, [orderId, inst, at]))[0].n
    if (Number(touched) > 0) throw new Error(`Pedido ${orderId} teve ${touched} item(ns) alterado(s) depois do C — corrija à mão`)

    const plan: string[] = []
    const run = async (label: string, sql: string, params: unknown[]) => {
      const r: any = (await conn.query(sql, params))[0]
      plan.push(`${label}: ${r.affectedRows} linha(s)`)
      return Number(r.affectedRows)
    }
    await run('nota revive', `UPDATE ${s}.tb_invoice SET deleted = 'N' WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'S' AND updated_at = ?`, [orderId, inst, at])
    // gate adversarial A13: o carimbo do C é por comando (NOW() pode virar o segundo) — ramo de serviço
    // que não revive com a nota = aborta, nunca nota viva sem ramo em silêncio
    const branchRevived: Record<string, number> = {}
    for (const t of ['tb_invoice_merchandise', 'tb_invoice_service']) {
      branchRevived[t] = await run(`${t} revive`, `UPDATE ${s}.${t} SET deleted = 'N' WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'S' AND updated_at = ?`, [orderId, inst, at])
    }
    for (const t of SNAPSHOT_TABLES) {
      await run(`${t} revive`, `UPDATE ${s}.${t} SET deleted = 'N' WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'S' AND updated_at = ?`, [orderId, inst, at])
    }
    if (branchRevived.tb_invoice_service === 0 && branchRevived.tb_invoice_merchandise === 0) {
      throw new Error('Nenhum ramo da nota casou com o instante do C — carimbos divergentes; corrija à mão (nada gravado)')
    }
    await run("pedido → 'C'", `UPDATE ${s}.tb_order SET status = 'C', updated_at = NOW() WHERE id = ? AND tb_institution_id = ? AND terminal = 0`, [orderId, inst])
    await run('OS solta a trava D5', `UPDATE ${s}.tb_service_order SET open_lock = NULL, updated_at = NOW() WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`, [orderId, inst])
    await run('competências devolvidas (Q-CA2)', `UPDATE ${s}.tb_contract_item_competence SET deleted = 'S', updated_at = NOW() WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0 AND deleted = 'N'`, [inst, orderId])

    console.log(`[repair-authorized-cancel] ${schema} pedido ${orderId} (chave ${keyed.access_key}, evento C de ${at.toISOString()})`)
    for (const line of plan) console.log('  ' + line)
    if (apply) {
      await conn.commit()
      console.log('  → GRAVADO')
    } else {
      await conn.rollback()
      console.log('  → simulação (rollback). Rode com --apply para gravar.')
    }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    await conn.end()
  }
}

main().catch(err => { console.error(`[repair-authorized-cancel] ${err.message}`); process.exit(1) })
