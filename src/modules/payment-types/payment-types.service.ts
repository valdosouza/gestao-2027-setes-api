import { HttpError } from '@shared/errors/http-error'
import {
  LinkedPaymentTypeRow, PaymentTypeCatalogRow, PaymentTypeLinkInput,
  PaymentTypeLinkUpdate,
} from './payment-types.interface'
import {
  listLinked, listCatalog, linkExists, linkOrCreatePaymentType,
  updateLink, unlinkPaymentType,
} from './payment-types.repository'

/**
 * Regras do módulo payment-types (workflow do Valdo, 2026-07-18): o
 * CLIENTE inicia o cadastro — o catálogo central deduplica por descrição e
 * a tela só gerencia o VÍNCULO da institution (PaymentTypeLinkAttrs —
 * enable/app_mobile/bloqueios/parcelas/TEF/planos de conta/uso).
 * description/id_nfce ficam imutáveis (linha compartilhada entre clientes).
 */

/** Escopo do usuário logado — sempre derivado do JWT, nunca do payload. */
export interface PaymentTypeScope {
  schemaName:    string
  institutionId: number
}

export async function fetchLinked(
  scope: PaymentTypeScope
): Promise<LinkedPaymentTypeRow[]> {
  return listLinked(scope.schemaName, scope.institutionId)
}

export async function fetchCatalog(
  filter: string, scope: PaymentTypeScope
): Promise<PaymentTypeCatalogRow[]> {
  return listCatalog(filter, scope.schemaName, scope.institutionId)
}

export async function saveLink(
  input: PaymentTypeLinkInput, scope: PaymentTypeScope
): Promise<{ id: number; reused: boolean }> {
  return linkOrCreatePaymentType(input, scope.schemaName, scope.institutionId)
}

export async function editLink(
  id: number, input: PaymentTypeLinkUpdate, scope: PaymentTypeScope
): Promise<void> {
  if (!(await linkExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Forma de pagamento ${id} não vinculada a este estabelecimento`)
  }
  await updateLink(id, input, scope.schemaName, scope.institutionId)
}

export async function removeLink(
  id: number, scope: PaymentTypeScope
): Promise<void> {
  if (!(await linkExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Forma de pagamento ${id} não vinculada a este estabelecimento`)
  }
  await unlinkPaymentType(id, scope.schemaName, scope.institutionId)
}
