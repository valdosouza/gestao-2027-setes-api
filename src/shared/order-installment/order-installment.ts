import { PoolConnection } from 'mysql2/promise'
import { assertSchema } from '@shared/db/schema'

/**
 * Peça `@shared/order-installment` → tb_order_installment
 * (prompt_negociacao_pedido.md D1/D2 emendada/§6): a PARCELA COMBINADA antes
 * do faturamento — data e valor ABSOLUTOS, forma própria opcional (NULL =
 * herda a forma do cabeçalho — REFERÊNCIA, resolvida só na materialização).
 * OPCIONAL: só existe quando o cliente negocia parcela a parcela; PRESENÇA =
 * elaborado, AUSÊNCIA = o prazo do billing gera (decisão 25). PK espelha
 * tb_financial (institution, order, terminal, parcel).
 *
 * "Voltar ao prazo" = padrão syncAddresses: upsert dos enviados +
 * deleted='S' nos ausentes; nunca DELETE físico; sem histórico de
 * negociações (seria peça de EVENTO, fora desta onda).
 *
 * As funções PURAS de materialização (parcelQuotas, addDays,
 * materializeParcels) vivem aqui — a grade GERADA que a tela mostra e as
 * parcelas que o faturamento cria saem da MESMA função (ver resolve.ts).
 */

type Queryable = Pick<PoolConnection, 'query'>

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export interface InstallmentRow {
  parcel: number
  /** 'YYYY-MM-DD' absoluto. */
  dueDate: string
  amount: number
  /** NULL = herda a forma do cabeçalho (tb_order_billing). */
  paymentTypeId: number | null
}

export async function getInstallments(
  db: Queryable, schemaName: string, institutionId: number, orderId: number
): Promise<InstallmentRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await db.query<any[]>(
    `SELECT parcel, DATE_FORMAT(due_date, '%Y-%m-%d') AS dueDate, amount,
            tb_payment_types_id AS paymentTypeId
       FROM \`${s}\`.tb_order_installment
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0
        AND deleted = 'N'
      ORDER BY parcel`,
    [orderId, institutionId]
  )
  return rows.map(r => ({
    parcel: Number(r.parcel),
    dueDate: String(r.dueDate),
    amount: Number(r.amount),
    paymentTypeId: r.paymentTypeId == null ? null : Number(r.paymentTypeId),
  }))
}

/**
 * Substitui o parcelamento ELABORADO pelo conjunto enviado: upsert parcela a
 * parcela (revive + sobrescreve) e deleted='S' nas que saíram. O CHAMADOR
 * valida (contiguidade 1..n, soma = base, formas habilitadas) e trava o
 * pedido — a peça só conhece a própria tabela.
 */
export async function replaceInstallments(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number,
  rows: InstallmentRow[]
): Promise<void> {
  const s = assertSchema(schemaName)
  for (const r of rows) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_order_installment
         (tb_institution_id, tb_order_id, terminal, parcel, due_date, amount,
          tb_payment_types_id, created_at, updated_at, deleted)
       VALUES (?, ?, 0, ?, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         due_date = VALUES(due_date), amount = VALUES(amount),
         tb_payment_types_id = VALUES(tb_payment_types_id),
         deleted = 'N', updated_at = NOW()`,
      [institutionId, orderId, r.parcel, r.dueDate, r.amount, r.paymentTypeId]
    )
  }
  const keep = rows.map(r => r.parcel)
  await conn.query(
    `UPDATE \`${s}\`.tb_order_installment SET deleted = 'S', updated_at = NOW()
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'
        ${keep.length > 0 ? `AND parcel NOT IN (${keep.map(() => '?').join(',')})` : ''}`,
    [orderId, institutionId, ...keep]
  )
}

/** "Voltar ao prazo": some o elaborado (soft) — a via simples volta a gerar. */
export async function clearInstallments(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number
): Promise<void> {
  const s = assertSchema(schemaName)
  await conn.query(
    `UPDATE \`${s}\`.tb_order_installment SET deleted = 'S', updated_at = NOW()
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [orderId, institutionId]
  )
}

// ---------------------------------------------------------------------
// Puras — materialização (única fonte para tela e faturamento)
// ---------------------------------------------------------------------

/** Rateio em N parcelas iguais com o RESÍDUO de centavos na última (FIN-03). */
export function parcelQuotas(total: number, parcels: number): number[] {
  const base = round2(total / parcels)
  const quotas = Array.from({ length: parcels }, () => base)
  const spread = round2(base * (parcels - 1))
  quotas[parcels - 1] = round2(total - spread)
  return quotas
}

/** Soma dias a uma data — formata em data LOCAL (nunca UTC: o vencimento não
 *  pode pular de dia por fuso, par do CURDATE() do MySQL). */
export function addDays(baseDate: Date, days: number): string {
  const d = new Date(baseDate)
  d.setDate(d.getDate() + days)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export interface MaterializedParcel {
  parcel: number
  dueDate: string
  amount: number
  /** SEMPRE resolvido (nunca null) — é o que o financeiro consome. */
  paymentTypeId: number
}

/**
 * Via SIMPLES: prazo (dias já parseados) × base → parcelas datadas a partir
 * de `baseDate` (faturamento ou "hoje" no preview), rateio com resíduo na
 * última, forma do cabeçalho em todas.
 */
export function materializeParcels(input: {
  days: number[]; base: number; baseDate: Date; paymentTypeId: number
}): MaterializedParcel[] {
  if (input.days.length === 0 || input.base <= 0) return []
  const quotas = parcelQuotas(input.base, input.days.length)
  return input.days.map((d, i) => ({
    parcel: i + 1, dueDate: addDays(input.baseDate, d), amount: quotas[i],
    paymentTypeId: input.paymentTypeId,
  }))
}
