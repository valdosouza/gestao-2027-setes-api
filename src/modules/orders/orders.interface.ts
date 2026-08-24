/**
 * Tipos do módulo orders — Pedido de Venda / Conjugado (2026-08-22).
 *
 * TELA DE PROCESSO (mesmo padrão de service-orders): backbone tb_order +
 * ramo tb_order_sale (SEMPRE — este módulo é a porta de entrada da VENDA).
 * Conjugada (mercadoria + serviço, ex.: autocenter que vende peça e cobra
 * a instalação) nasce por PRESENÇA: o primeiro item de serviço adicionado
 * cria o ramo tb_order_service (lazy, open_lock SEMPRE NULL — não é o
 * mesmo conceito de "1 OS aberta por cliente" do módulo service-orders,
 * são backbones distintos). Faturamento NÃO é ação deste módulo — a tela
 * chama /api/billing/validate + /api/billing/invoice (já implementados).
 * Espelho no app: apps/web/lib/app/modules/orders/.
 */

export interface OrderListRow {
  id:           number
  number:       number | null
  customerId:   number
  customerName: string | null
  salesmanId:   number
  salesmanName: string | null
  status:       'A' | 'F'
  dtRecord:     string | null
  hasService:   boolean
  itemsCount:   number
  totalValue:   number
}

export interface OrderItemRow {
  id:                 number
  kind:               'Sale' | 'Service'
  productId:          number
  productDescription: string | null
  productKind:        'P' | 'M' | 'S'
  quantity:           number
  unitValue:          number
  discountValue:      number
  total:              number
}

export interface OrderFull {
  id:           number
  number:       number | null
  customerId:   number
  customerName: string | null
  salesmanId:   number
  salesmanName: string | null
  status:       'A' | 'F'
  dtRecord:     string | null
  items:        OrderItemRow[]
  totalValue:   number
}

export interface OpenOrderInput {
  customerId: number
  salesmanId?: number | null
}

export interface OrderItemInput {
  productId:      number
  quantity:       number
  unitValue:      number
  discountValue?: number | null
}

/** Lookup de itens ativos (mercadoria: kind P/M; serviço: kind S). */
export interface OrderProductLookupRow {
  id:          number
  description: string
  kind:        'P' | 'M' | 'S'
}
