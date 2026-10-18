import { InstitutionPayload } from '@shared/types/express'
import { isSuper, SETES_INSTITUTION_ID } from '@shared/auth/roles'
import { userHasPrivilege, resolveInterfaceId, PrivilegeVerdict } from '@shared/auth/require-privilege'

/**
 * Telas do grupo Super DELEGÁVEIS a usuário da Setes (D-PV11, Valdo 2026-10-18 — `prompt_privilegios_interfaces.md`):
 *   (a) só o que está nesta lista (hoje: o vínculo estabelecimento × interfaces dos clientes — "Interfaces dos clientes");
 *   (b) a liberação é POR USUÁRIO e SÓ o Super concede — até o admin da Setes precisa do privilégio marcado (exceção à regra
 *       "admin passa o privilégio"); o cadastro de privilégios só oferece estas telas ao Super;
 *   (c) só usuário da institution da Setes (id 1) — a tela não existe para os clientes;
 *   (d) as demais telas do Super seguem só do Super.
 * A licença (contrato) NÃO entra: tela do Super não é vendida — a liberação do Super é a única chave.
 */
export const DELEGABLE_SUPER_INTERFACES: readonly string[] = ['institution-interfaces']

export function isDelegableSuperInterface(interfaceKey: string | null | undefined): boolean {
  return interfaceKey != null && DELEGABLE_SUPER_INTERFACES.includes(interfaceKey)
}

/**
 * Veredito de uma tela DELEGÁVEL: super passa; usuário de OUTRA institution → a tela não existe para ele (`not-contracted`);
 * usuário da Setes (admin INCLUSIVE) → só com o privilégio marcado pelo Super.
 */
export async function delegatedSuperVerdict(
  inst: InstitutionPayload, keys: readonly string[], privilegeId: number
): Promise<PrivilegeVerdict> {
  const delegable = keys.filter(isDelegableSuperInterface)
  if (isSuper(inst)) {
    for (const key of delegable) if ((await resolveInterfaceId(key)) != null) return 'ok'
    return 'not-contracted'
  }
  if (inst.institutionId !== SETES_INSTITUTION_ID || delegable.length === 0) return 'not-contracted'
  for (const key of delegable) {
    if (await userHasPrivilege(inst.schemaName, inst.userId, key, privilegeId)) return 'ok'
  }
  return 'no-privilege'
}
