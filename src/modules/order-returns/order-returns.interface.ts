/**
 * Tipos do módulo order-returns — DEVOLUÇÃO de mercadoria (parecer
 * setes-conceito 2026-08-24): processo que conduz um ajuste de Entrada
 * ancorado num pedido de venda FATURADO, da abertura ao faturamento.
 * 1º produtor do ramo tb_order_stock_adjust; a âncora
 * (tb_order_stock_adjust_return) nasce AQUI, na abertura.
 */

export interface OrderReturnListRow {
  id: number
  number: number | null
  originOrderId: number
  originNumber: number | null
  customerId: number
  customerName: string
  status: string
  dtRecord: string | null
  itemsCount: number
  totalValue: number
}

export interface OrderReturnItemRow {
  id: number
  productId: number
  productDescription: string | null
  quantity: number
  /** teto de edição = saldo devolvível do produto excluindo ESTA devolução */
  maxQuantity: number
  unitValue: number
  total: number
}

export interface OrderReturnFull {
  id: number
  number: number | null
  status: string
  dtRecord: string | null
  originOrderId: number
  originNumber: number | null
  customerId: number
  customerName: string
  totalValue: number
  items: OrderReturnItemRow[]
}

/** Produto devolvível da origem (pré-carga da abertura — grão POR PRODUTO). */
export interface ReturnableProduct {
  productId: number
  available: number
  unitValue: number
}
