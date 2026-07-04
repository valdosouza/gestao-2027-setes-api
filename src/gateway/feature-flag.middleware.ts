import { Request, Response, NextFunction } from 'express'
import { isModuleEnabled } from '@feature-flags/flag.service'
import { isSuper } from '@shared/auth/roles'
import logger from '@shared/logger/logger'

export function featureFlagMiddleware(req: Request, res: Response, next: NextFunction) {
  // Formato esperado: /api/<moduleKey>/...
  const moduleKey = req.path.split('/')[2]

  if (!moduleKey) return next()

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
