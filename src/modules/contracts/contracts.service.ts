import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import { walletSalesmanId } from '@shared/customer-wallet'
import {
  ContractListRow, ContractFull, ContractInput, ProductLookupRow,
  LookupRow,
} from './contracts.interface'
import {
  listContracts, getContract, insertContract, updateContract,
  softDeleteContract, listProductsLookup,
  CONTRACT_SEARCH_CRITERIA, listCustomerLookup, listPaymentTypesLookup,
} from './contracts.repository'

/**
 * Regras do módulo contracts: escopo SEMPRE da institution do JWT;
 * cliente validado no papel local dentro da transação (400); 404 sem
 * vazar existência de outros escopos. Mensalidade = SUM dos itens (DP3)
 * — calculada na leitura, nunca gravada.
 */

export interface ContractScope {
  schemaName:    string
  institutionId: number
  /** quem pergunta — a carteira travada do vendedor vale no lookup de cliente (D-BA27) */
  userId:        number
  role?:         string
}

export { CONTRACT_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchContractSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(CONTRACT_SEARCH_CRITERIA)
}

/** D-BA27: a carteira é da PESSOA — vendedor travado só enxerga os seus clientes aqui também. */
export async function fetchCustomerLookup(filter: string, scope: ContractScope): Promise<LookupRow[]> {
  const salesmanId = await walletSalesmanId({ ...scope, role: scope.role ?? '' })
  return listCustomerLookup(filter, scope.schemaName, scope.institutionId, salesmanId)
}

export async function fetchPaymentTypesLookup(filter: string, scope: ContractScope): Promise<LookupRow[]> {
  return listPaymentTypesLookup(filter, scope.schemaName, scope.institutionId)
}

export async function fetchContracts(
  query: ListQuery, scope: ContractScope
): Promise<PagedRows<ContractListRow>> {
  return listContracts(query, scope.schemaName, scope.institutionId)
}

export async function fetchContract(
  id: number, scope: ContractScope
): Promise<ContractFull> {
  const contract = await getContract(id, scope.schemaName, scope.institutionId)
  if (!contract) throw new HttpError(404, `Contrato ${id} não encontrado`)
  return contract
}

export async function createContract(
  input: ContractInput, scope: ContractScope
): Promise<number> {
  return insertContract(input, scope.schemaName, scope.institutionId)
}

export async function editContract(
  id: number, input: ContractInput, scope: ContractScope
): Promise<void> {
  const found = await updateContract(id, input, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Contrato ${id} não encontrado`)
}

export async function removeContract(
  id: number, scope: ContractScope
): Promise<void> {
  const found = await softDeleteContract(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Contrato ${id} não encontrado`)
}

export async function fetchProductsLookup(
  filter: string, scope: ContractScope
): Promise<ProductLookupRow[]> {
  return listProductsLookup(filter, scope.schemaName, scope.institutionId)
}
