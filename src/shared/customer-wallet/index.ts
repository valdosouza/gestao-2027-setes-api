import { InstitutionPayload } from '@shared/types/express'
import { getConfigContent } from '@shared/interface-config'
import { getSessionContext } from '@shared/session-context'

/**
 * CARTEIRA DO VENDEDOR (Framework de Configurações, decisão 15 — piloto no
 * customers). Promovida a peça no 2º consumidor (Q-BA13 da pesquisa avançada,
 * Valdo 2026-09-30): a carteira é regra da PESSOA, não da tela — toda porta que
 * mostra cliente (lista/GET de customers, lookup de cliente da OS) pergunta aqui.
 *
 * Config `restrict_customer_to_salesman` = 'S' (interface customers) + usuário
 * vendedor (session-context) → devolve o id a forçar (`tb_customer.tb_salesman_id
 * = userId`); senão null (sem restrição).
 */
export async function walletSalesmanId(payload: InstitutionPayload): Promise<number | null> {
  const content = await getConfigContent(payload, 'customers', 'restrict_customer_to_salesman')
  if (content !== 'S') return null
  const context = await getSessionContext(payload)
  return context.isSalesman ? payload.userId : null
}
