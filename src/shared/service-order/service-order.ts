import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchema } from '@shared/db/schema'

/**
 * Peça da ORDEM DE SERVIÇO consumida por quem desfaz efeitos dela fora do
 * módulo — hoje o cancelamento de nota (Q-G3, Valdo 2026-09-09: "a nota da OS
 * deve ser cancelável"). Conhece UMA regra do ciclo: a OS aberta segura a
 * trava D5 (`open_lock` = "<institution>-<cliente>", UNIQUE — 1 OS aberta por
 * cliente); faturar solta a trava, cancelar a nota devolve.
 *
 * IDENTIDADE (D-G11, migration 047 — parecer setes-conceito 2026-09-09):
 * `tb_order_service` é NATUREZA por presença (venda com item de serviço,
 * pedido sincronizado, OS); o CICLO da Ordem de Serviço vive em
 * `tb_service_order`, cujo ÚNICO produtor é o módulo service-orders. Ser OS
 * = ter o ciclo. Venda com serviço e pedido sincronizado (mesmo o de serviço
 * puro, sem tb_order_sale) nunca têm linha aqui — a identidade não depende
 * mais da ausência de um ramo nem do sync gravar ou não eventos de nota.
 *
 * O módulo service-orders continua dono do ciclo (abrir/itens/faturar);
 * módulo nunca importa módulo — por isso a reabertura vive aqui.
 */

export interface ServiceOrderForReopen {
  customerId: number
  /** Valor da trava D5 a restaurar na reabertura. */
  openLock: string
  /** Outra OS do MESMO cliente já aberta (trava ocupada) — bloqueio legível. */
  blockingOrderId: number | null
}

/**
 * Lê a OS do pedido SOB LOCK (FOR UPDATE — mesma ordem do faturamento da OS:
 * pedido → tb_order_service → financeiro) e confere a trava D5. A consulta da
 * trava também é travante: o valor ausente ganha gap lock, então abrir uma OS
 * para o mesmo cliente enquanto o cancelamento roda espera o commit.
 * Devolve null quando o pedido NÃO tem ciclo de OS (venda — com ou sem item
 * de serviço — e pedido sincronizado).
 */
export async function findServiceOrderForReopen(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number
): Promise<ServiceOrderForReopen | null> {
  const s = assertSchema(schemaName)
  const [rows] = await conn.query<any[]>(
    `SELECT so.tb_customer_id AS customerId
       FROM \`${s}\`.tb_service_order c
       JOIN \`${s}\`.tb_order_service so
         ON so.id = c.id AND so.tb_institution_id = c.tb_institution_id
        AND so.terminal = c.terminal AND so.deleted = 'N'
      WHERE c.id = ? AND c.tb_institution_id = ? AND c.terminal = 0 AND c.deleted = 'N'
      FOR UPDATE`,
    [orderId, institutionId]
  )
  if (!rows[0]) return null
  const customerId = Number(rows[0].customerId)
  const openLock = openLockOf(institutionId, customerId)
  const [open] = await conn.query<any[]>(
    `SELECT id FROM \`${s}\`.tb_service_order
      WHERE tb_institution_id = ? AND open_lock = ? AND deleted = 'N' AND id <> ?
      LIMIT 1 FOR UPDATE`,
    [institutionId, openLock, orderId]
  )
  return { customerId, openLock, blockingOrderId: open[0] ? Number(open[0].id) : null }
}

/**
 * Q-A11 (3ª adversarial): o billing de VENDA não conhece o ciclo — uma OS
 * (cancelada e com `tb_order_billing` viva) passava por `validate`/`invoice`
 * de venda e ficava 'F' com a trava D5 presa. Ser OS = ter ciclo vivo; a OS
 * fatura SÓ por `POST /service-orders/:id/invoice`.
 */
export async function hasServiceOrderCycle(
  schemaName: string, institutionId: number, orderId: number
): Promise<boolean> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM \`${s}\`.tb_service_order
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' LIMIT 1`,
    [orderId, institutionId]
  )
  return rows.length > 0
}

/** Mesma composição do módulo (`CONCAT(institution, '-', cliente)`). */
export function openLockOf(institutionId: number, customerId: number): string {
  return `${institutionId}-${customerId}`
}

/**
 * Devolve a trava D5 à OS (nota cancelada → OS volta a ABERTA e editável).
 * ER_DUP_ENTRY = outra OS do cliente abriu entre o plano e a execução → 409
 * legível em vez de 500 (cinto; o plano já bloqueia o caso normal).
 */
export async function reopenServiceOrder(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number, openLock: string
): Promise<void> {
  const s = assertSchema(schemaName)
  try {
    await conn.query(
      `UPDATE \`${s}\`.tb_service_order SET open_lock = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
      [openLock, orderId, institutionId]
    )
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Cliente já tem outra ordem de serviço aberta — feche-a antes de cancelar a nota desta',
        undefined, 'SERVICE_ORDER_CUSTOMER_OPEN')
    }
    throw err
  }
}
