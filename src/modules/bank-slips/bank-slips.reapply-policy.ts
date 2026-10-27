import { InstitutionPayload } from '@shared/types/express'
import { privilegeVerdict, PrivilegeVerdict } from '@shared/auth/require-privilege'
import { PRIVILEGE_ALTERAR, PRIVILEGE_CANCELAR } from '@shared/auth/privileges'
import type { RegistrationEventRow } from '@shared/bank-slip-registration'

/**
 * POLÍTICA do "reaplicar a voz do banco" (D-PV27, Valdo 2026-10-20 — fecha a Q-PV22 = (b); molde da política do desconto,
 * ARQUITETURA_MODULOS_API "Privilégio de AÇÃO: rota × controller"): o ato NÃO fala com o banco — aplica no ERP o efeito que o
 * banco já disse. Pelo princípio "o privilégio nomeia a FINALIDADE do ato, nunca o transporte", o privilégio exigido é o do
 * EFEITO reaplicado, decidido pela VOZ do evento antes de executar:
 *   R (RECEBIDO)  → produz L (liquidação) no boleto → ALTERAR (o mesmo que liquidar à mão — D-PV7);
 *   C (CANCELADO) e V (EXPIRADO) → produzem C (cancelamento) → CANCELAR (o mesmo que cancelar à mão — D-PV7).
 * Qualquer outra voz não produz efeito (a peça devolve 409 BANK_SLIP_EFFECT_NOT_PENDING) — aqui vale o verbo mais exigente,
 * CANCELAR, para a política nunca liberar o que a peça vai recusar.
 * Interface conferida: a da tela de boletos (`bank-slips`); licença antes do privilégio, super e admin pelas regras de sempre.
 */
export const REAPPLY_INTERFACE = 'bank-slips'

export function reapplyPrivilegeFor(kind: string | null | undefined): number {
  return kind === 'R' ? PRIVILEGE_ALTERAR : PRIVILEGE_CANCELAR
}

export interface ReapplyPolicyVerdict {
  verdict: PrivilegeVerdict
  privilegeId: number
  interfaces: readonly string[]
}

export async function reapplyEffectVerdict(
  inst: InstitutionPayload, event: Pick<RegistrationEventRow, 'kind'>
): Promise<ReapplyPolicyVerdict> {
  const privilegeId = reapplyPrivilegeFor(event.kind)
  const interfaces = [REAPPLY_INTERFACE] as const
  return { verdict: await privilegeVerdict(inst, interfaces, privilegeId), privilegeId, interfaces }
}
