import { Request, Response, NextFunction } from 'express'
import { verifyFinalToken } from '@shared/auth/product-token'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import logger from '@shared/logger/logger'
import { runAsActor } from '@shared/request-actor'

/**
 * Autenticação das rotas /api/* pelo token FINAL do produto — RS256 com `kid` (D-F13, F2a etapa A2):
 * HS256, token sem `kid`/com `kid` desconhecido e o token de SELEÇÃO são recusados (`@shared/auth/product-token`).
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Token ausente', undefined, ErrorCodes.UNAUTHORIZED)

    const payload = verifyFinalToken(header.slice(7).trim())

    req.institution = payload
    logger.info('Auth OK', { institutionId: payload.institutionId, path: req.path })
    // D-F151: o autor da requisição para quem registra sem receber o payload (o alarme da porta da voz do fisco)
    runAsActor({ institutionId: payload.institutionId, userId: payload.userId }, next)
  } catch (err) {
    // envelope do Framework de Mensagens ({ error, code }) — o app recebe UnauthorizedFailure com o código
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code ?? ErrorCodes.UNAUTHORIZED })
    } else {
      res.status(401).json({ error: 'Token inválido ou expirado', code: ErrorCodes.UNAUTHORIZED })
    }
  }
}
