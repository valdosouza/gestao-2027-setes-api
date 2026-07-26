import { HttpError } from '@shared/errors/http-error'
import { getConfigContent } from '@shared/interface-config'
import { getSessionContext } from '@shared/session-context'
import {
  CustomerInput, CustomerListRow, CustomerFull, RoleLookupRow,
  PartnershipPartnerRow, PartnershipPartnerInput,
} from './customers.interface'
import {
  listCustomers, getCustomer, customerExists,
  insertCustomerCascade, updateCustomerCascade, deleteCustomer,
  listSalesmanLookup, listCarrierLookup,
  getCustomerPartnership, setCustomerPartnership,
} from './customers.repository'

/**
 * Regras do módulo customers (Fase 3 Entidade Única): o reuso por documento
 * e o last-write-wins são da CADEIA (@shared/entity); aqui ficam o escopo por
 * institution (JWT), o 404 e a tradução de corrida em 409 legível.
 */

/** Escopo do usuário logado — sempre derivado do JWT, nunca do payload. */
export interface CustomerScope {
  schemaName:    string
  institutionId: number
  userId:        number
  role:          string
}

/**
 * Filtro de carteira (piloto do Framework de Configurações, decisão 15):
 * com restrict_customer_to_salesman='S' e o usuário sendo vendedor
 * (tb_salesman via session-context), a lista e o GET :id ficam PRESOS a
 * tb_customer.tb_salesman_id = userId. Quem não é vendedor não sofre
 * restrição. Devolve o salesmanId a forçar, ou null (sem restrição).
 */
async function restrictedSalesmanId(scope: CustomerScope): Promise<number | null> {
  const content = await getConfigContent(scope, 'customers', 'restrict_customer_to_salesman')
  if (content !== 'S') return null
  const context = await getSessionContext(scope)
  return context.isSalesman ? scope.userId : null
}

/** Corrida no INSERT (UNIQUE de cpf/cnpj ou PK do papel) vira 409 legível. */
function dupEntryTo409(err: any): never {
  if (err?.code === 'ER_DUP_ENTRY') {
    throw new HttpError(409, 'Registro em conflito — tente novamente (cadastro simultâneo detectado)',
      undefined, 'CONFLICT_RETRY')
  }
  throw err
}

export async function fetchCustomers(
  filter: string, scope: CustomerScope
): Promise<CustomerListRow[]> {
  const salesmanId = await restrictedSalesmanId(scope)
  return listCustomers(filter, scope.schemaName, scope.institutionId, salesmanId)
}

export async function fetchCustomer(id: number, scope: CustomerScope): Promise<CustomerFull> {
  const row = await getCustomer(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Cliente ${id} não encontrado`)
  // Decisão 15: fora da carteira = 404 (mesmo padrão de não vazar existência
  // do workflow de usuários).
  const salesmanId = await restrictedSalesmanId(scope)
  if (salesmanId !== null && row.tbSalesmanId !== salesmanId) {
    throw new HttpError(404, `Cliente ${id} não encontrado`)
  }
  return row
}

export async function createCustomer(
  input: CustomerInput, scope: CustomerScope
): Promise<{ id: number; reused: boolean }> {
  try {
    return await insertCustomerCascade(input, scope.schemaName, scope.institutionId, scope.userId)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function editCustomer(
  id: number, input: CustomerInput, scope: CustomerScope
): Promise<void> {
  if (!(await customerExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Cliente ${id} não encontrado`)
  }
  try {
    await updateCustomerCascade(id, input, scope.schemaName, scope.institutionId, scope.userId)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function removeCustomer(id: number, scope: CustomerScope): Promise<void> {
  if (!(await customerExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Cliente ${id} não encontrado`)
  }
  await deleteCustomer(id, scope.schemaName, scope.institutionId)
}

export async function fetchSalesmanLookup(
  filter: string, scope: CustomerScope
): Promise<RoleLookupRow[]> {
  return listSalesmanLookup(filter, scope.schemaName, scope.institutionId)
}

export async function fetchCarrierLookup(
  filter: string, scope: CustomerScope
): Promise<RoleLookupRow[]> {
  return listCarrierLookup(filter, scope.schemaName, scope.institutionId)
}

// ---------------------------------------------------------------------
// ABA PARCERIA (Parceria v2): a parceria É do cliente (angariação) —
// escopo do JWT; Σ rate ≤ 90 validada no DTO e re-checada aqui.
// ---------------------------------------------------------------------

export async function fetchCustomerPartnership(
  customerId: number, scope: CustomerScope
): Promise<PartnershipPartnerRow[]> {
  await fetchCustomer(customerId, scope)  // 404 + filtro de carteira
  return getCustomerPartnership(customerId, scope.schemaName, scope.institutionId)
}

export async function saveCustomerPartnership(
  customerId: number, partners: PartnershipPartnerInput[], scope: CustomerScope
): Promise<void> {
  const total = partners.filter(p => p.active === 'S')
    .reduce((sum, p) => sum + p.rate, 0)
  if (total > 90) {
    throw new HttpError(400, 'A soma dos percentuais ativos não pode passar de 90%',
      [{ field: 'partners', message: `Soma atual: ${total}%` }],
      'RATE_SUM_EXCEEDED')
  }
  await fetchCustomer(customerId, scope)  // 404 + filtro de carteira
  await setCustomerPartnership(customerId, partners,
    scope.schemaName, scope.institutionId)
}
