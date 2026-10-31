import { Request, Response, NextFunction } from 'express'
import { verifyFinalTokenWithIat } from '@shared/auth/product-token'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import logger from '@shared/logger/logger'
import { runAsActor } from '@shared/request-actor'
import { liveSession } from '@shared/access'

/**
 * Autenticação das rotas /api/* pelo token FINAL do produto — RS256 com `kid` (D-F13, F2a etapa A2):
 * HS256, token sem `kid`/com `kid` desconhecido e o token de SELEÇÃO são recusados (`@shared/auth/product-token`).
 *
 * Costura A1 da auth-api (D-UC9 + D-AU3, Valdo 2026-10-31): depois da assinatura, a SESSÃO VIVA — o vínculo do usuário com o
 * estabelecimento do token, a credencial e o estabelecimento seguem ativos (`setes_central.vw_user_link`, pela biblioteca única
 * `fiscal-api/access`)? Senão 401 SESSION_REVOKED: inativar o vínculo, a credencial ou o estabelecimento vale NA HORA em TODA rota —
 * inclusive `adminGuard`/`superGuard`, rotas abertas e o `/api/core/me` (por onde o app confirma o 401 da nfse-api — D-F148). O `role`
 * do token é TROCADO pelo PERFIL VIVO (rebaixar/promover vale na hora; até a A2 o token ainda o leva, mas ninguém confia nele).
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Token ausente', undefined, ErrorCodes.UNAUTHORIZED)

    const token = verifyFinalTokenWithIat(header.slice(7).trim())
    const payload = await liveSession(token.payload, token.iat)   // D-EA7: o iat derruba o token anterior à troca de senha
    if (!payload) {
      throw new HttpError(401, 'O acesso deste usuário a este estabelecimento não vale mais — entre de novo', undefined,
        ErrorCodes.SESSION_REVOKED)
    }

    req.institution = payload
    // D-EA12 (Valdo 2026-10-31): a linha `Auth OK` por requisição SAIU — ruído sem valor forense (a falha é que vai ao log)
    // D-F151: o autor da requisição para quem registra sem receber o payload (o alarme da porta da voz do fisco)
    runAsActor({ institutionId: payload.institutionId, userId: payload.userId }, next)
  } catch (err) {
    // envelope do Framework de Mensagens ({ error, code }) — o app recebe UnauthorizedFailure com o código
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code ?? ErrorCodes.UNAUTHORIZED })
    } else if (isDbFailure(err)) {
      // a sessão não pôde ser LIDA (banco fora): não é "token inválido" — o app não deve derrubar o login por isso
      logger.error('Sessão viva não pôde ser lida (banco)', { message: (err as Error).message })
      res.status(503).json({ error: 'Serviço indisponível — tente novamente', code: ErrorCodes.SESSION_UNAVAILABLE })
    } else {
      res.status(401).json({ error: 'Token inválido ou expirado', code: ErrorCodes.UNAUTHORIZED })
    }
  }
}

/** Erro do driver/banco (não do token): conexão recusada, tempo esgotado, SQL do driver. */
function isDbFailure(err: unknown): boolean {
  const e = err as { code?: unknown; errno?: unknown; sqlState?: unknown } | null
  return !!e && (typeof e.errno === 'number' || typeof e.sqlState === 'string'
    || (typeof e.code === 'string' && /^(ECONN|ETIMEDOUT|PROTOCOL_|ER_|EPIPE|ENOTFOUND)/.test(e.code)))
}
