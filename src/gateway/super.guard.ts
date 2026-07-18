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

/**
 * Guard "leitura aberta, escrita Super" (fix 2026-07-18): os cadastros
 * GEOGRÁFICOS (countries/states/cities) são dados de REFERÊNCIA lidos pelos
 * lookups de endereço de TODO cadastro de cliente (aba Endereços da cadeia
 * fiscal) — o GET precisa funcionar para qualquer usuário autenticado; só a
 * manutenção (POST/PUT/DELETE) continua restrita ao Super.
 */
export function superWriteGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET') {
    next()
    return
  }
  superGuard(req, res, next)
}
