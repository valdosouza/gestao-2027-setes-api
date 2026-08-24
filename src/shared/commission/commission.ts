import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'

/**
 * Peça compartilhada da COMISSÃO por item (rodada Q1–Q5 do Valdo,
 * 2026-08-24 + parecer setes-conceito) — lançamento IMUTÁVEL: devolução
 * entra como value NEGATIVO, nunca UPDATE/DELETE (Q2, filosofia do
 * financeiro imutável). Positivo e negativo nascem pela MESMA função —
 * o sinal vem do fato gerador, não da peça.
 *
 * kind: 'F' = comissão pelo faturamento | 'R' = pelo recebimento (Q5 —
 * modo por config `commission_mode`, registrado para a peça completa;
 * nesta versão mínima só 'F' tem produtor).
 *
 * Reconciliação (decisão do Valdo 2026-08-24): qualquer reversão futura
 * (cancelamento de nota, estorno de devolução) entra SEMPRE como
 * lançamento novo de compensação — nunca soft delete/UPDATE de linha
 * desta tabela.
 *
 * Fonte da alíquota (semântica do VEN_PROPORCAO do legado, agora
 * resolvida na hora do lançamento): tb_salesman.kickback_product = 'S'
 * → alíquota POR PRODUTO (tb_price.aliq_kickback da lista do item, com
 * fallback na do vendedor); senão → tb_salesman.aliq_kickback.
 */

export interface CommissionEntryInput {
  kind: 'F' | 'R'
  orderId: number
  orderItemId: number
  orderItemKind: string
  customerId: number
  salesmanId: number
  baseValue: number
  aliq: number
  /** Negativo = estorno por devolução. */
  value: number
}

export interface PostedItemCommission {
  orderItemId: number
  orderItemKind: string
  salesmanId: number
  customerId: number
  aliq: number
}

export async function resolveCommissionAliq(
  schemaName: string, institutionId: number, salesmanId: number,
  productId: number, priceListId: number | null
): Promise<number> {
  const s = assertSchema(schemaName)
  const [sm] = await pool.query<any[]>(
    `SELECT aliq_kickback AS aliq, kickback_product AS byProduct
       FROM \`${s}\`.tb_salesman
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [salesmanId, institutionId]
  )
  if (!sm[0]) return 0
  const salesmanAliq = Number(sm[0].aliq ?? 0)

  if (String(sm[0].byProduct ?? 'N') === 'S' && priceListId !== null) {
    const [pr] = await pool.query<any[]>(
      `SELECT aliq_kickback AS aliq FROM \`${s}\`.tb_price
        WHERE tb_institution_id = ? AND tb_price_list_id = ? AND tb_product_id = ?
          AND deleted = 'N'`,
      [institutionId, priceListId, productId]
    )
    if (pr[0] && pr[0].aliq !== null) return clampAliq(Number(pr[0].aliq))
  }
  return clampAliq(salesmanAliq)
}

// tb_price/tb_salesman também são alimentadas fora deste módulo (telas
// próprias e sincronizador) — o domínio 0..100 do DTO de salesmen não é
// garantia aqui (achado MEDIUM do gate adversarial 2026-08-24): alíquota
// negativa viraria comissão negativa em VENDA; > 100, comissão maior que
// a mercadoria.
function clampAliq(aliq: number): number {
  if (!Number.isFinite(aliq) || aliq < 0) return 0
  return Math.min(aliq, 100)
}

/** Lançamentos POSITIVOS já postados para uma ordem (fonte da alíquota do
 *  estorno: a devolução espelha o que foi de fato comissionado na venda). */
export async function getPostedItemCommissions(
  schemaName: string, institutionId: number, orderId: number
): Promise<PostedItemCommission[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT tb_order_item_id AS orderItemId, tb_order_item_kind AS orderItemKind,
            tb_salesman_id AS salesmanId, tb_customer_id AS customerId, aliq
       FROM \`${s}\`.tb_commission
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
        AND value > 0 AND deleted = 'N'`,
    [institutionId, orderId]
  )
  return rows.map(r => ({
    orderItemId: Number(r.orderItemId), orderItemKind: String(r.orderItemKind),
    salesmanId: Number(r.salesmanId), customerId: Number(r.customerId),
    aliq: Number(r.aliq ?? 0),
  }))
}

/**
 * INSERT em LOTE (transaction-aware) — o MAX+1 sob FOR UPDATE é reservado
 * UMA vez para a nota inteira (R6 do gate socrático 2026-08-24: por
 * lançamento seria N locks no índice da institution por faturamento —
 * deadlock latente entre notas concorrentes). Devolve os ids gerados.
 */
export async function insertCommissions(
  conn: PoolConnection, schemaName: string, institutionId: number,
  entries: CommissionEntryInput[]
): Promise<number[]> {
  if (entries.length === 0) return []
  const s = assertSchema(schemaName)
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
       FROM \`${s}\`.tb_commission WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )
  let id = Number(mx[0].nextId)
  const ids: number[] = []
  for (const entry of entries) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_commission
         (id, tb_institution_id, terminal, kind, tb_order_id, tb_order_item_id,
          tb_order_item_kind, tb_customer_id, tb_salesman_id,
          base_value, aliq, value, dt_payment, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NOW(), NOW())`,
      [id, institutionId, entry.kind, entry.orderId, entry.orderItemId,
       entry.orderItemKind, entry.customerId, entry.salesmanId,
       entry.baseValue, entry.aliq, entry.value]
    )
    ids.push(id)
    id += 1
  }
  return ids
}

/** INSERT de UM lançamento — atalho sobre o lote. */
export async function insertCommission(
  conn: PoolConnection, schemaName: string, institutionId: number,
  entry: CommissionEntryInput
): Promise<number> {
  const [id] = await insertCommissions(conn, schemaName, institutionId, [entry])
  return id
}
