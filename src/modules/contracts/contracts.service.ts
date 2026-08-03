import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  ContractListRow, ContractFull, ContractInput, ProductLookupRow,
} from './contracts.interface'
import {
  listContracts, getContract, insertContract, updateContract,
  softDeleteContract, listProductsLookup,
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
