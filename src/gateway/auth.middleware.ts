import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { InstitutionPayload } from '@shared/types/express'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Token ausente')

    const token   = header.split(' ')[1]
    const secret  = process.env.JWT_SECRET!
    const payload = jwt.verify(token, secret) as InstitutionPayload

    if (!payload.institutionId || !payload.role) throw new HttpError(401, 'Token inválido')

    req.institution = payload
    logger.info('Auth OK', { institutionId: payload.institutionId, path: req.path })
    next()
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message })
    } else {
      res.status(401).json({ error: 'Token inválido ou expirado' })
    }
  }
}
