import { InstitutionPayload } from '@shared/types/express'
import { isSuper, isOwnVendorInstitution } from '@shared/auth/roles'
import { isDelegableSuperInterface } from '@shared/auth/delegable-interfaces'
import { userHasPrivilege, resolveInterfaceId, PrivilegeVerdict } from '@shared/auth/require-privilege'

/**
 * Guarda DELEGADA (D-PV11, Valdo 2026-10-18 — `prompt_privilegios_interfaces.md`). A LISTA das telas delegáveis vive no
 * módulo-folha `delegable-interfaces.ts` (lida também pela conferência de "adquirida" — D-PV39 — sem ciclo de import);
 * aqui fica só o veredito. Re-exportada para os consumidores que já a importavam daqui.
 */
export { DELEGABLE_SUPER_INTERFACES, isDelegableSuperInterface } from '@shared/auth/delegable-interfaces'

/**
 * Veredito de uma tela DELEGÁVEL: super passa; usuário de OUTRA institution → a tela não existe para ele (`not-contracted`);
 * usuário da Setes (admin INCLUSIVE) → só com o privilégio marcado pelo Super. D-PV37: "a Setes" pelo predicado único.
 * O veredito delegado NÃO entra no cache da D-PV29 (não há licença a cachear; o vínculo é uma consulta só).
 */
export async function delegatedSuperVerdict(
  inst: InstitutionPayload, keys: readonly string[], privilegeId: number
): Promise<PrivilegeVerdict> {
  const delegable = keys.filter(isDelegableSuperInterface)
  if (isSuper(inst)) {
    for (const key of delegable) if ((await resolveInterfaceId(key)) != null) return 'ok'
    return 'not-contracted'
  }
  if (!isOwnVendorInstitution(inst.institutionId) || delegable.length === 0) return 'not-contracted'
  for (const key of delegable) {
    if (await userHasPrivilege(inst.schemaName, inst.userId, key, privilegeId)) return 'ok'
  }
  return 'no-privilege'
}
