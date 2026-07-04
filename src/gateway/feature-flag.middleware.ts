import { Request, Response, NextFunction } from 'express'
import { isModuleEnabled } from '@feature-flags/flag.service'
import logger from '@shared/logger/logger'

export function featureFlagMiddleware(req: Request, res: Response, next: NextFunction) {
  // Formato esperado: /api/<moduleKey>/...
  const moduleKey = req.path.split('/')[2]

  if (!moduleKey) return next()

  // Setes admin passa direto
  if (req.tenant?.role === 'setes_admin') return next()

  const tenantId = req.tenant!.tenantId

  isModuleEnabled(tenantId, moduleKey)
    .then(enabled => {
      if (!enabled) {
        logger.warn('Módulo bloqueado', { tenantId, moduleKey })
        res.status(403).json({ error: `Módulo "${moduleKey}" não habilitado para este cliente` })
        return
      }
      next()
    })
    .catch(() => res.status(500).json({ error: 'Erro ao verificar permissões' }))
}
