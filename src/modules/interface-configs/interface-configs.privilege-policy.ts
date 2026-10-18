import { resolveInterfaceId } from '@shared/auth/require-privilege'
import type { DynamicInterfaces } from '@shared/auth/module-privilege-gate'

/**
 * Interfaces cujo privilégio abre o painel de configurações (D-PV2 + A-PV8 — `prompt_privilegios_interfaces.md`).
 *
 * O painel é a interface `interface-configs`; a "Configurações Gerais" (`general-configs`, D-PV1: V + A) não tem módulo
 * próprio — o clique no menu abre ESTE painel filtrado nela (`navigateToInterface` no app). Sem esta política o privilégio
 * dela não teria consumidor: quem só tem a "Configurações Gerais" leria/gravaria as configs DELA, nunca as de outra tela.
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
