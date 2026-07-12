import { Request, Response, NextFunction } from 'express'
import { isModuleEnabled } from '@feature-flags/flag.service'
import { isSuper } from '@shared/auth/roles'
import logger from '@shared/logger/logger'

// Módulos fora do gate tb_feature_flag: todo cliente autenticado precisa deles
// para o app sequer carregar ('core' serve o menu em /api/core/menus).
const FLAG_EXEMPT_MODULES = new Set(['core'])

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
