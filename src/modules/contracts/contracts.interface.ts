/**
 * Tipos do módulo contracts — Contratos de serviço (Módulo Software House,
 * prompt FECHADO prompt_modulo_software_house.md; Valdo 2026-07-18).
 * tb_contract no SCHEMA DO CLIENTE (PK id + tb_institution_id; id MAX+1
 * por institution) + tb_contract_item (N produtos — D9) com valor MENSAL
 * por produto; mensalidade do contrato = SUM dos itens (DP3, sem campo
 * redundante). dt_start obrigatória, dt_end opcional (D1/4.2);
 * payment_day informativo — o vencimento do faturamento é decidido pelo
 * usuário na tela (DP1). Alimenta a rotina mensal do ciclo de serviços.
 * Espelho no app: apps/web/lib/app/modules/contracts/.
 */

/** Linha da LISTA (nome do cliente vem da entity central). */
export interface ContractListRow {
  id:           number
  customerId:   number
  customerName: string | null
  dtStart:      string
  dtEnd:        string | null
  monthlyValue: number
  active:       'S' | 'N'
}

export interface ContractItemRow {
  productId:          number
  productDescription: string | null
  value:              number
}

/** Objeto COMPLETO do GET /:id. */
export interface ContractFull {
  id:           number
  customerId:   number
  customerName: string | null
  dtStart:      string
  dtEnd:        string | null
  paymentDay:   number
  active:       'S' | 'N'
  items:        ContractItemRow[]
}

export interface ContractItemInput {
  productId: number
  value:     number
}

/** POST/PUT — itens SEMPRE completos (a API sincroniza por productId). */
export interface ContractInput {
  customerId: number
  dtStart:    string
  dtEnd?:     string | null
  paymentDay: number
  active:     'S' | 'N'
  items:      ContractItemInput[]
}

/** Lookup de produtos/serviços do form (tb_product da institution). */
export interface ProductLookupRow {
  id:          number
  description: string
}
