import { resolveInterfaceId } from '@shared/auth/require-privilege'
import type { DynamicInterfaces } from '@shared/auth/module-privilege-gate'

/**
 * Interfaces cujo VISUALIZAR deixa NAVEGAR até o painel de configurações (D-PV2 + A-PV8 — `prompt_privilegios_interfaces.md`).
 *
 * O painel é a interface `interface-configs`; a "Configurações Gerais" (`general-configs`) não tem módulo próprio — o clique no
 * menu abre ESTE painel filtrado nela (`navigateToInterface` no app). D-PV25 (2026-10-20): a GRAVAÇÃO do valor da institution
 * não é mais decidida aqui — é CONFIGURAR na interface ALVO (`@shared/auth/configure-privilege`, no service); esta política só
 * diz quem pode abrir o painel (V do painel, ou V da general-configs quando o painel é o dela).
 */
export const CONFIGS_VITRINE: readonly string[] = ['interface-configs', 'general-configs']

export const CONFIGS_PANEL: DynamicInterfaces = {
  possible: ['interface-configs', 'general-configs'],
  async resolve(params) {
    const generalId = await resolveInterfaceId('general-configs')
    const target = Number(params.id)
    return generalId !== null && Number.isSafeInteger(target) && target === generalId
      ? ['interface-configs', 'general-configs']
      : ['interface-configs']
  },
}
