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
  errors:    { customerId: number; contractId?: number; productId?: number; message: string }[]
}

/** Gerar Faturamento — vencimento DECIDIDO PELO USUÁRIO (DP1). */
export interface InvoiceInput {
  dtExpiration:  string
  paymentTypeId: number
  parcels:       number
  /**
   * M1 do gate socrático da Rodada 5 (D23): quais condições vieram do FATO da
   * competência (lote sem override) e por isso são RECONFERIDAS dentro da
   * transação, depois do lock da ordem — a leitura fora da transação serve ao
   * relatório e à recusa antecipada, a de dentro é a que grava (a rotina mensal
   * escreve na mesma tabela e na mesma OS aberta entre as duas).
   */
  termsFromContract?: { dtExpiration: boolean; paymentTypeId: boolean }
}

export interface InvoiceResult {
  invoiceNumber: string
  parcels:       number
  totalValue:    number
  /** Condições REALMENTE gravadas no título (as reconferidas na transação — M1). */
  dtExpiration:  string
  paymentTypeId: number
  /** Parcelas que nasceram BAIXADAS pelo regra de recebimento da forma. */
  autoSettled:     number
  /** Boletos emitidos automaticamente no faturamento. */
  bankSlipsIssued: number
  /** Parcelas com valor > 0 — o denominador da cobrança (D26). */
  chargeableParcels: number
}

/** Lookup de produtos/serviços ativos (itens avulsos). */
export interface ServiceProductLookupRow {
  id:          number
  description: string
}

/**
 * LOTE da cobrança mensal (D6/D7 — fase Primeiro Cliente): uma linha por
 * ordem, com o resultado REAL de cada uma. Ordem que falha não derruba as
 * outras (D7) e sai no relatório com o motivo legível e o código do catálogo.
 */
export interface BatchInvoiceInput
  extends Omit<InvoiceInput, 'dtExpiration' | 'paymentTypeId'> {
  orderIds: number[]
  /** D13: ausente = cada ordem vence no dia do SEU contrato. */
  dtExpiration?: string
  /** D14: ausente = cada ordem usa a forma do SEU contrato. */
  paymentTypeId?: number
}

export interface BatchInvoiceEntry {
  orderId:        number
  ok:             boolean
  /** Vencimento REALMENTE usado nesta ordem — com a D13 ele varia por cliente. */
  dtExpiration?:  string
  /** Forma REALMENTE usada nesta ordem (D14). */
  paymentTypeId?: number
  invoiceNumber?: string
  totalValue?:    number
  /** O que a automação fez nesta ordem — "faturada" não quer dizer "cobrada". */
  autoSettled?:     number
  bankSlipsIssued?: number
  /**
   * D26 (Q-P5): cobrança POR PARCELA — `chargedParcels` = baixadas + com boleto,
   * `chargeableParcels` = parcelas com valor. Menor que o total = cobrança PARCIAL
   * (nota de 3 parcelas com 1 boleto), que antes passava por "cobrada".
   */
  chargedParcels?:    number
  chargeableParcels?: number
  error?:         string
  code?:          string
  /**
   * D25 (Q-P3): a ordem recusada por CONTENÇÃO já foi reexecutada UMA vez ao
   * final do lote e continuou ocupada — "tente de novo" é decisão do operador.
   */
  retryable?:     boolean
}

export interface BatchInvoiceReport {
  requested: number
  invoiced:  number
  failed:    number
  /** Faturadas com QUALQUER parcela sem baixa e sem boleto — o pior caso da
   *  cobrança mensal é o lote "100 % faturado" e nada cobrado (gate adversarial);
   *  D26: a parcial (1 de 3 parcelas cobrada) também conta aqui. */
  uncharged: number
  /** Subconjunto de `uncharged`: faturadas com cobrança PARCIAL (0 < cobradas < cobráveis). */
  partiallyCharged: number
  /** Recusadas por contenção que a passada extra (D25) NÃO resolveu — repetir é do operador. */
  retryable: number
  results:   BatchInvoiceEntry[]
}
