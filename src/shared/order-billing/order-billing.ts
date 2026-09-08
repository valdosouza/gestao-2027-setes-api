import { PoolConnection } from 'mysql2/promise'
import { assertSchema } from '@shared/db/schema'

/**
 * Peça `@shared/order-billing` → tb_order_billing (prompt_negociacao_pedido.md
 * D2/§6): COMO o pedido será cobrado — forma de pagamento + prazo RELATIVO
 * (dias contados do faturamento, string livre `028/056/084` — decisão 31 da
 * fase). Registro OBRIGATÓRIO da cobrança para vendas e compras; 1:1 com
 * tb_order por PK compartilhada. A via SIMPLES da negociação (decisão 25):
 * sem parcelamento elaborado, é este prazo que GERA as parcelas no
 * faturamento.
 *
 * Colisão de nomes herdada: módulo `billing` = FATURAMENTO; esta peça =
 * COBRANÇA do pedido (tb_order_billing). Não renomear (parecer 2026-09-06).
 */

type Queryable = Pick<PoolConnection, 'query'>

/** Teto de sanidade: prazo por parcela nunca passa de 10 anos (dado sujo do sync). */
export const MAX_DEADLINE_DAYS = 3650

/**
 * LEITURA tolerante do prazo ("028/056/084" → dias por parcela). Aceita
 * separadores variados e lixo parcial (o campo é texto livre vindo do sync);
 * vazio = à vista (1 parcela, 0 dias); dia acima do teto devolve null (o
 * caller responde 422 INVALID_DEADLINE, nunca 500). Para GRAVAR use
 * `normalizeDeadline` (estrito).
 */
export function parseDeadline(deadline: string | null | undefined): number[] | null {
  const raw = (deadline ?? '').trim()
  if (!raw) return [0]
  const days = raw.split(/[\/,;|-]/)
    .map(p => parseInt(p.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 0)
  if (days.length === 0) return [0]
  if (days.some(d => d > MAX_DEADLINE_DAYS)) return null
  return days
}

export type NormalizedDeadline =
  | { valid: true; deadline: string | null; days: number[] }
  | { valid: false; reason: string }

/**
 * GRAVAÇÃO estrita do prazo (parecer §6, Q3): cada parte tem de ser um
 * inteiro 0..MAX; canônico = 3 dígitos separados por '/'. Vazio ou só "0"
 * = à vista → deadline NULL (1 parcela, 0 dias). Lixo → inválido (o erro
 * aparece na NEGOCIAÇÃO, não no faturamento).
 */
export function normalizeDeadline(input: string | null | undefined): NormalizedDeadline {
  const raw = (input ?? '').trim()
  if (!raw) return { valid: true, deadline: null, days: [0] }
  const parts = raw.split(/[\/,;|-]/).map(p => p.trim())
  const days: number[] = []
  for (const p of parts) {
    if (!/^\d{1,4}$/.test(p)) return { valid: false, reason: `Parcela "${p}" não é um número de dias` }
    const n = parseInt(p, 10)
    if (n > MAX_DEADLINE_DAYS) return { valid: false, reason: `Prazo de ${n} dias passa do limite (${MAX_DEADLINE_DAYS})` }
    days.push(n)
  }
  if (days.length === 1 && days[0] === 0) return { valid: true, deadline: null, days: [0] }
  return { valid: true, deadline: days.map(d => String(d).padStart(3, '0')).join('/'), days }
}

export interface OrderBillingRow {
  paymentTypeId: number
  /** Nº de parcelas da VIA SIMPLES — DERIVADO (nunca input livre na venda). */
  plots: number | null
  /** Prazo canônico ou NULL (à vista / não se aplica — OS). */
  deadline: string | null
}

export async function getOrderBilling(
  db: Queryable, schemaName: string, institutionId: number, orderId: number
): Promise<OrderBillingRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await db.query<any[]>(
    `SELECT tb_payment_types_id AS paymentTypeId, plots, deadline
       FROM \`${s}\`.tb_order_billing
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [orderId, institutionId]
  )
  if (!rows[0]) return null
  const plots = parseInt(String(rows[0].plots ?? ''), 10)
  return {
    paymentTypeId: Number(rows[0].paymentTypeId),
    plots: Number.isInteger(plots) ? plots : null,
    deadline: rows[0].deadline ? String(rows[0].deadline) : null,
  }
}

export interface OrderBillingInput {
  paymentTypeId: number
  /** Já NORMALIZADO pelo chamador (`normalizeDeadline`); NULL = à vista / não se aplica. */
  deadline: string | null
  /** Só quem NÃO tem prazo informa (OS: nº de parcelas do contrato); venda deriva do prazo. */
  plots?: number
}

/** 1:1 por PK compartilhada → upsert (vocabulário da casa: upsertFiscal, upsertEntityTax). */
export async function upsertOrderBilling(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number,
  input: OrderBillingInput
): Promise<void> {
  const s = assertSchema(schemaName)
  const plots = input.plots ?? (parseDeadline(input.deadline) ?? [0]).length
  await conn.query(
    `INSERT INTO \`${s}\`.tb_order_billing
       (id, tb_institution_id, terminal, tb_payment_types_id, plots, deadline,
        created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       tb_payment_types_id = VALUES(tb_payment_types_id),
       plots = VALUES(plots), deadline = VALUES(deadline),
       deleted = 'N', updated_at = NOW()`,
    [orderId, institutionId, input.paymentTypeId, String(plots).padStart(3, '0'), input.deadline]
  )
}
