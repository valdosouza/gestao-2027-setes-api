/**
 * Tipos do módulo billing — validação + faturamento de ordens (W2 Onda 3,
 * rodada R4 do prompt_fase_faturamento_financeiro.md). Dois endpoints:
 * /validate (lote completo de issues + grava regra por item origin 'A') e
 * /invoice (fatura consumindo as regras gravadas, sem recheck).
 */

export type OrderBranch = 'sale' | 'purchase' | 'adjust' | 'service'

export interface ValidationIssue {
  scope: 'order' | 'emitter' | 'recipient' | 'item'
  itemId?: number
  field?: string
  message: string
}

export interface ValidationReport {
  orderId: number
  branch: OrderBranch
  issues: ValidationIssue[]
  /** Itens com regra resolvida nesta validação (gravados origin 'A'). */
  rulesResolved: number
  /** Itens que já tinham escolha manual (origin 'M' — respeitados). */
  rulesManual: number
}

export interface InvoiceResult {
  orderId: number
  invoiceNumber: string
  serie: string
  model: string
  totalValue: number
  parcels: number
}

/** Linha viva de tb_order_item para o faturamento. */
export interface BillingOrderItem {
  id: number
  kind: string
  productId: number
  quantity: number
  unitValue: number
  discountValue: number
  productKind: 'P' | 'M' | 'S'
  ncm: string | null
  origin: string | null       // tb_merchandise.source (origem da mercadoria)
  merchandiseSt: 'S' | 'N'
  purpose: string | null      // kind_tributary (finalidade)
}

/** Linha de tb_order_item_tax_rule. */
export interface ItemTaxRuleLink {
  orderItemId: number
  kind: string
  taxRuleId: number
  cfopId: string | null
  setFinancial: 'S' | 'N'
  origin: 'M' | 'A'
}
