import { PaymentTypeLinkAttrs } from '@shared/payment-types'

/**
 * Tipos do módulo payment-types — Formas de Pagamento (Valdo, 2026-07-18):
 * catálogo COMPARTILHADO em setes_central.tb_payment_types + vínculo/uso
 * por institution em setes_<schema>.tb_institution_has_payment_types
 * (atributos do vínculo em PaymentTypeLinkAttrs — @shared/payment-types).
 * O CLIENTE inicia o cadastro: existe no catálogo = só vincula; não existe
 * = cria na central (reuso por DESCRIÇÃO dentro da transação — mesmo
 * espírito da entidade única) e vincula. description é IMUTÁVEL depois de
 * criada (chave do reuso); id_nfce é editável na tela (PUT atualiza a
 * linha central — vale para todos os clientes vinculados).
 * id_nfce = código de pagamento da NF-e/NFC-e (2 dígitos, lista fiscal
 * fixa — combobox no app: 01 Dinheiro … 90 Sem Pagamento, 99 Outros).
 * Espelho no app: apps/web/lib/app/modules/payment_types/.
 */

/** Forma VINCULADA à institution (lista da tela) + descrições dos planos
 *  de conta (JOIN — só leitura, para exibição no form). */
export interface LinkedPaymentTypeRow extends PaymentTypeLinkAttrs {
  id:          number
  description: string
  idNfce:      string | null
  financialPlanCreDescription: string | null
  financialPlanDebDescription: string | null
}

/** Linha do catálogo central (lookup do form), marcando as já vinculadas. */
export interface PaymentTypeCatalogRow {
  id:          number
  description: string
  idNfce:      string | null
  linked:      'S' | 'N'
}

/** POST: vincular existente ([paymentTypeId]) OU criar/reusar por
 *  [description] (+ idNfce) — os atributos do vínculo acompanham. */
export interface PaymentTypeLinkInput extends PaymentTypeLinkAttrs {
  paymentTypeId?: number | null
  description?:   string | null
  idNfce?:        string | null
}

/** PUT: atributos do VÍNCULO + idNfce ([undefined] = não mexer; o código
 *  vive na linha central COMPARTILHADA — atualizar vale para todos os
 *  clientes vinculados). */
export type PaymentTypeLinkUpdate = PaymentTypeLinkAttrs & {
  idNfce?: string | null
}
