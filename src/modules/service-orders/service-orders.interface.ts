/**
 * Tipos do módulo service-orders — Ordens de Serviço / ciclo mensal
 * (Módulo Software House, seções 4.4–4.6 e 6 do prompt FECHADO;
 * Fases 3 e 6 do doc 05-ORDEM-SERVICO-SOFTWARE-HOUSE.md).
 *
 * 1ª TELA DE PROCESSO do produto: a OS fica ABERTA o mês inteiro
 * acumulando itens (tarefas avulsas + itens de contrato injetados pela
 * rotina mensal com pró-rata); Gerar Faturamento emite a fatura interna
 * (tb_invoice model 'SE' — DP8), gera tb_financial + bills 'RA' com
 * VENCIMENTO DECIDIDO PELO USUÁRIO (DP1 — 5º dia útil é só o default) e
 * fecha a ordem (status na tb_order — DP7; open_lock esvazia — D5).
 * Identidade do backbone: tb_order.id = tb_order_service.id =
 * tb_invoice.id = tb_financial.tb_order_id.
 * Espelho no app: apps/web/lib/app/modules/service_orders/.
 */

export interface ServiceOrderListRow {
  id:           number
  number:       number | null
  customerId:   number
  customerName: string | null
  status:       'A' | 'F'
  dtRecord:     string | null
  itemsCount:   number
  totalValue:   number
}

export interface ServiceOrderItemRow {
  id:                 number
  productId:          number
  productDescription: string | null
  quantity:           number
  unitValue:          number
  discountValue:      number
  total:              number
}

export interface ServiceOrderFull {
  id:           number
  number:       number | null
  customerId:   number
  customerName: string | null
  status:       'A' | 'F'
  dtRecord:     string | null
  items:        ServiceOrderItemRow[]
  totalValue:   number
  /** Preenchidos quando FATURADA. */
  invoiceNumber: string | null
  dtEmission:    string | null
}

export interface OpenOrderInput {
  customerId: number
}

export interface OrderItemInput {
  productId:      number
  quantity:       number
  unitValue:      number
  discountValue?: number | null
}

export interface MonthlyRunInput {
  year:  number
  month: number
}

/** Relatório da rotina mensal (D8 — botão manual). */
export interface MonthlyRunReport {
  processed: number
  opened:    number
  injected:  number
  skipped:   number
  errors:    { customerId: number; message: string }[]
}

/** Gerar Faturamento — vencimento DECIDIDO PELO USUÁRIO (DP1). */
export interface InvoiceInput {
  dtExpiration:  string
  paymentTypeId: number
  parcels:       number
}

export interface InvoiceResult {
  invoiceNumber: string
  parcels:       number
  totalValue:    number
}

/** Lookup de produtos/serviços ativos (itens avulsos). */
export interface ServiceProductLookupRow {
  id:          number
  description: string
}
