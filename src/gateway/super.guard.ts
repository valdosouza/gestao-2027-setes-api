import { Request, Response, NextFunction } from 'express'
import { isSuper } from '@shared/auth/roles'

/**
 * Guard dos cadastros do catálogo central: acesso restrito ao superusuário
 * da Setes. Aplicado POR MÓDULO no gateway (router.use('/countries',
 * superGuard, ...)) — "Super" é agrupador de menu no app e não aparece em
 * pasta NEM em URL (decisão do Valdo, 2026-07-11: /api/<modulo> espelha
 * /home/<modulo>). Não há verificação de tb_institution_has_interface nem
 * tb_user_has_privilege para o Super — decisão registrada em 2026-07-09.
 */
export function superGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isSuper(req.institution)) {
    res.status(403).json({ error: 'Acesso restrito à equipe Setes' })
    return
  }
  next()
}
