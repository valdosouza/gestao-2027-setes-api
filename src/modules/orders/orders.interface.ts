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

// ---------------------------------------------------------------------
// Negociação (prompt_negociacao_pedido.md D1–D7): via SIMPLES (cabeçalho =
// tb_order_billing, @shared/order-billing) × via ELABORADA (grade =
// tb_order_installment, @shared/order-installment). `mode` é DERIVADO da
// presença do elaborado — nunca coluna. `preview` = parcelas GERADAS do prazo
// sobre a base do PEDIDO (nunca gravadas; a base da NOTA, com impostos, só
// existe no faturamento — D7 põe a diferença na 1ª parcela).
// ---------------------------------------------------------------------

export interface NegotiationParcelRow {
  parcel:                 number
  dueDate:                string
  amount:                 number
  /** Forma RESOLVIDA (cabeçalho quando a parcela não tem a sua). */
  paymentTypeId:          number
  paymentTypeDescription: string | null
  /** kind do catálogo (Q = cheque → o faturamento exige os cheques desta parcela). */
  paymentTypeKind:        string | null
  /** Só no elaborado: true quando a parcela tem forma PRÓPRIA (não herdada). */
  ownPaymentType:         boolean
}

export interface OrderNegotiation {
  orderId:      number
  /** 'A' aberto (editável) | 'F' faturado (somente leitura). */
  status:       'A' | 'F'
  mode:         'simple' | 'elaborated'
  billing: {
    paymentTypeId:          number
    paymentTypeDescription: string | null
    paymentTypeKind:        string | null
    maxParcels:             number | null
    /** Prazo como gravado (pode ser legado do sync: 'A VISTA', '30/60/90 DIAS'). */
    deadline:               string | null
    /** Q-N4: canônico '028/056/084' (null = à vista) quando o gravado passa no
     *  normalizador; `deadlineValid=false` = legado tolerado — o PUT aceita o
     *  MESMO raw de volta, qualquer prazo novo é estrito. */
    deadlineCanonical:      string | null
    deadlineValid:          boolean
    plots:                  number | null
  } | null
  /** Base do PEDIDO (itens set_financial + frete) — a que a negociação enxerga. */
  base: { itemsValue: number; freight: number; base: number }
  /** Parcelamento ELABORADO gravado (vazio na via simples). */
  installments: NegotiationParcelRow[]
  /** Grade GERADA do prazo a partir de hoje (via simples; vazia sem billing/base). */
  preview:      NegotiationParcelRow[]
}

/** Lookup dos bancos do catálogo central (cheques do faturamento — mesmo shape de /api/checks/banks). */
export interface OrderBankLookupRow {
  id:          number
  number:      string
  description: string | null
}

export interface NegotiationInput {
  paymentTypeId: number
  deadline?:     string | null
  installments?: { parcel: number; dueDate: string; amount: number; paymentTypeId?: number | null }[]
}
