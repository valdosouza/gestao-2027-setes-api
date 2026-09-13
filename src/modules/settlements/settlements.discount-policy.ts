import { HttpError } from '@shared/errors/http-error'
import { isAdmin } from '@shared/auth/roles'
import { userHasPrivilege } from '@shared/auth/require-privilege'
import { PRIVILEGE_DESCONTO } from '@shared/auth/privileges'
import { getConfigContent } from '@shared/interface-config'
import { toCents } from '@shared/money'
import { InstitutionPayload } from '@shared/types/express'

export const DISCOUNT_LIMIT_CONFIG = 'max_discount_aliquot'
export const SETTLEMENTS_INTERFACE = 'settlements'
export const CHARGE_AGREEMENTS_INTERFACE = 'bank-charge-agreements'

/**
 * D-G32 (Q-G32, Valdo 2026-09-13): "por config determina o teto, o privilégio
 * DESCONTO autoriza e bypassa a validação". Legado BX-15: desconto na baixa a
 * receber exigia autorização de outro usuário; aqui o teto vem do Framework de
 * Configurações (`max_discount_aliquot` na interface `settlements`, scope I —
 * default 0 = nenhum desconto sem o privilégio, fiel ao legado) e quem tem o
 * privilégio DESCONTO (seed 55) passa sem teto. Admin/super passam (regra dos
 * guards). Só a porta MANUAL: boleto (desconto congelado da carteira) e cheque
 * (sem desconto) não passam por aqui.
 */
export async function assertDiscountPolicy(
  inst: InstitutionPayload, titles: { discountAliquot?: number | null }[]
): Promise<void> {
  const requested = Math.max(0, ...titles.map(t => Number(t.discountAliquot ?? 0)))
  return assertDiscountAliquot(inst, requested, SETTLEMENTS_INTERFACE)
}

/**
 * D-G36 (Valdo 2026-09-13, "concordo"): a MESMA política guarda a alíquota de
 * desconto da CARTEIRA de cobrança — a porta do boleto concedia desconto sem
 * privilégio nem teto e, com a D-G30, isso QUITA o título (gate adversarial da
 * Rodada 6: usuário regular quitou 100,00 recebendo 50,00). O privilégio é
 * conferido na interface de quem faz o ato (`bank-charge-agreements` ao cadastrar
 * a carteira; `settlements` ao baixar), e o teto é o mesmo da empresa.
 */
export async function assertDiscountAliquot(
  inst: InstitutionPayload, requested: number, interfaceKey: string
): Promise<void> {
  if (!(requested > 0)) return
  if (isAdmin(inst)) return
  if (await userHasPrivilege(inst.schemaName, inst.userId, interfaceKey, PRIVILEGE_DESCONTO)) return
  const limit = Math.max(0, Number(await getConfigContent(inst, SETTLEMENTS_INTERFACE, DISCOUNT_LIMIT_CONFIG) ?? 0) || 0)
  // L-2 (adversarial da Rodada 6): comparação em CENTAVOS da alíquota — a folga
  // de 1e-9 deixava 5.000000001 passar num teto de 5 (política de autorização
  // não tem por que ter folga; o DECIMAL(…,2) é a régua).
  if (toCents(requested) > toCents(limit)) {
    throw new HttpError(403,
      `Desconto de ${requested}% acima do teto da empresa (${limit}%) — exige o privilégio DESCONTO`,
      [{ field: 'discountAliquot', message: `Máximo ${limit}% sem o privilégio DESCONTO`, expected: limit }],
      'DISCOUNT_REQUIRES_PRIVILEGE')
  }
}
