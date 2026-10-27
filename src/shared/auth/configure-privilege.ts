import { InstitutionPayload } from '@shared/types/express'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { PRIVILEGE_CONFIGURAR } from '@shared/auth/privileges'
import { privilegeVerdict, resolveInterfaceKey, PrivilegeVerdict } from '@shared/auth/require-privilege'

/**
 * CONFIGURAR (D-PV25/D-PV26, Valdo 2026-10-20 — prompt_privilegios_interfaces.md): "pode ajustar o comportamento desta tela".
 * Gravar o valor da INSTITUTION ('I') de uma configuração e o required/caption/mask de um campo da tela X exige CONFIGURAR em X,
 * por QUALQUER caminho (engrenagem da tela X → painel; painel solto do menu Sistema com X selecionada). UMA regra, UM lugar: os
 * dois services dos painéis (`interface-configs`, `interface-fields`) resolvem o veredito pela interface ALVO (não pela do painel —
 * o VISUALIZAR do painel só deixa navegar); "Configurações Gerais" = CONFIGURAR em `general-configs` (a interface alvo É ela).
 * Admin passa sempre (D32), o super escapa (A-PV1/D-PV24), o regular precisa do par (interface × CONFIGURAR) — que existe no
 * catálogo para toda interface com config ou campo (seed 68). O override PESSOAL ('U') segue aberto (A-PV6) — não passa por aqui.
 * O veredito segue a MESMA peça das guardas (licença antes do privilégio; cache da D-PV29).
 */
export async function configureVerdict(inst: InstitutionPayload, interfaceId: number): Promise<PrivilegeVerdict> {
  const key = await resolveInterfaceKey(interfaceId)
  if (key === null) return 'not-contracted'        // interface fora do catálogo (ou excluída): nega para todos — integridade
  return privilegeVerdict(inst, [key], PRIVILEGE_CONFIGURAR)
}

/** Para a tela decidir o alvo do salvar ('I' × 'U') e mostrar/esconder a engrenagem — aditivo nas respostas dos painéis. */
export async function canConfigure(inst: InstitutionPayload, interfaceId: number): Promise<boolean> {
  return (await configureVerdict(inst, interfaceId)) === 'ok'
}

/** 403 no mesmo envelope das guardas (INTERFACE_NOT_ALLOWED × PRIVILEGE_REQUIRED). */
export async function assertCanConfigure(inst: InstitutionPayload, interfaceId: number): Promise<void> {
  const verdict = await configureVerdict(inst, interfaceId)
  if (verdict === 'ok') return
  if (verdict === 'not-contracted') {
    throw new HttpError(403, 'Interface não contratada para este estabelecimento', [], ErrorCodes.INTERFACE_NOT_ALLOWED)
  }
  throw new HttpError(403, 'Privilégio CONFIGURAR necessário nesta tela para alterar o comportamento dela', [],
    ErrorCodes.PRIVILEGE_REQUIRED)
}
