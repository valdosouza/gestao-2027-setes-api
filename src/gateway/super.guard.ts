import { Request, Response, NextFunction } from 'express'
import { isSuper } from '@shared/auth/roles'

/**
 * Guard da área /api/super/*: acesso restrito ao superusuário da Setes.
 *
 * "Super" NÃO é um módulo de código — é agrupador de menu no app e, aqui,
 * apenas prefixo de URL + este guard (simetria com ARQUITETURA_MODULOS.md
 * do setes-app: módulo de sistema nunca vira pasta). Não há verificação de
 * tb_institution_has_interface nem tb_user_has_privilege para o Super —
 * decisão registrada em 2026-07-09.
 */
export function superGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isSuper(req.institution)) {
    res.status(403).json({ error: 'Acesso restrito à equipe Setes' })
    return
  }
  next()
}
