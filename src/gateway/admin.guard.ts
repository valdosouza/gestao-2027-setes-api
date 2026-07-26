import { Request, Response, NextFunction } from 'express'
import { isAdmin } from '@shared/auth/roles'

/**
 * Guard dos cadastros operáveis pelo ADMIN da própria institution
 * (workflow de usuários, decisão do Valdo 2026-07-12): super passa
 * (gerencia qualquer institution — o escopo alvo vai no request);
 * admin passa restrito à institution do JWT (o service FORÇA o escopo).
 * Aplicado POR MÓDULO no gateway, na mesma posição do superGuard.
 */
export function adminGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isAdmin(req.institution)) {
    res.status(403).json({ error: 'Acesso restrito a administradores' })
    return
  }
  next()
}
