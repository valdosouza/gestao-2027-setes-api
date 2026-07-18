import { Request, Response, NextFunction } from 'express'
import { isModuleEnabled } from '@feature-flags/flag.service'
import { isSuper } from '@shared/auth/roles'
import logger from '@shared/logger/logger'

// Módulos fora do gate tb_feature_flag: todo cliente autenticado precisa deles
// para o app sequer carregar ('core' serve o menu em /api/core/menus;
// 'interface-fields' serve a config resolvida que monta TODA tela — Fase 2;
// 'entities' serve o prefill by-document dos cadastros da cadeia fiscal —
// Fase 3, decisão 10: aberto a qualquer usuário autenticado;
// 'interface-configs' serve a config resolvida por módulo — Framework de
// Configurações: mesmo papel de infraestrutura do interface-fields;
// 'countries'/'states'/'cities' são referência geográfica dos lookups de
// endereço de qualquer cadastro da cadeia fiscal — fix 2026-07-18).
const FLAG_EXEMPT_MODULES = new Set([
  'core', 'interface-fields', 'entities', 'interface-configs',
  'countries', 'states', 'cities',
])

export function featureFlagMiddleware(req: Request, res: Response, next: NextFunction) {
  // Montado em app.use('/api', ...): o Express remove o prefixo do mount,
  // então /api/<moduleKey>/... chega aqui com req.path = /<moduleKey>/...
  const moduleKey = req.path.split('/')[1]

  if (!moduleKey) return next()

  if (FLAG_EXEMPT_MODULES.has(moduleKey)) return next()

  // Superusuário da Setes passa direto (decisão 14)
  if (isSuper(req.institution)) return next()

  const institutionId = req.institution!.institutionId

  isModuleEnabled(institutionId, moduleKey)
    .then(enabled => {
      if (!enabled) {
        logger.warn('Módulo bloqueado', { institutionId, moduleKey })
        res.status(403).json({ error: `Módulo "${moduleKey}" não habilitado para este cliente` })
        return
      }
      next()
    })
    .catch(() => res.status(500).json({ error: 'Erro ao verificar permissões' }))
}
