import { Request, Response, NextFunction } from 'express'
import { isModuleEnabled } from '@feature-flags/flag.service'
import { isSuper } from '@shared/auth/roles'
import { isGatedModule } from '@shared/auth/module-privilege-gate'
import logger from '@shared/logger/logger'
import { ErrorCodes } from '@shared/errors/error-codes'

// Módulos fora do gate tb_feature_flag: todo cliente autenticado precisa deles
// para o app sequer carregar ('core' serve o menu em /api/core/menus;
// 'interface-fields' serve a config resolvida que monta TODA tela — Fase 2;
// 'entities' serve o prefill by-document dos cadastros da cadeia fiscal —
// Fase 3, decisão 10: aberto a qualquer usuário autenticado;
// 'interface-configs' serve a config resolvida por módulo — Framework de
// Configurações: mesmo papel de infraestrutura do interface-fields;
// 'countries'/'states'/'cities' são referência geográfica dos lookups de
// endereço de qualquer cadastro da cadeia fiscal — fix 2026-07-18).
export const FLAG_EXEMPT_MODULES: ReadonlySet<string> = new Set([
  'core', 'interface-fields', 'entities', 'interface-configs',
  'countries', 'states', 'cities',
])

/**
 * D-PV36 (Valdo 2026-10-20 — prompt_privilegios_interfaces.md): a flag técnica MORREU para os módulos que passam pela guarda
 * por roteador (`gatedModule`): lá o vínculo `tb_institution_has_interface` é a ÚNICA licença (D-F37/D-PV2) — a flag seria uma
 * 2ª licença sem tela, que nenhuma porta sincroniza com o contrato. O middleware só vale para o que NÃO tem tela guardada
 * (rotas de sistema do perfil admin, billing, state-tax-rates…). Etapa 1 da decisão; o DROP das linhas é DDL à parte.
 */
export function flagApplies(moduleKey: string): boolean {
  return !FLAG_EXEMPT_MODULES.has(moduleKey) && !isGatedModule(moduleKey)
}

export function featureFlagMiddleware(req: Request, res: Response, next: NextFunction) {
  // Montado em app.use('/api', ...): o Express remove o prefixo do mount,
  // então /api/<moduleKey>/... chega aqui com req.path = /<moduleKey>/...
  const moduleKey = req.path.split('/')[1]

  if (!moduleKey) return next()

  if (!flagApplies(moduleKey)) return next()

  // Superusuário da Setes passa direto (decisão 14)
  if (isSuper(req.institution)) return next()

  const institutionId = req.institution!.institutionId

  isModuleEnabled(institutionId, moduleKey)
    .then(enabled => {
      if (!enabled) {
        logger.warn('Módulo bloqueado', { institutionId, moduleKey })
        res.status(403).json({ error: `Módulo "${moduleKey}" não habilitado para este cliente`, code: ErrorCodes.MODULE_NOT_ENABLED, fields: [] })
        return
      }
      next()
    })
    .catch(() => res.status(500).json({ error: 'Erro ao verificar permissões' }))
}
