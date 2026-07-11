import { Response, Request } from 'express'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

/**
 * Utilidades compartilhadas pelos controllers dos módulos de cadastro
 * (padrão simétrico módulo-a-módulo — ver ARQUITETURA_MODULOS_API.md).
 */

export function handleError(res: Response, err: unknown, ctx: string): void {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message })
    return
  }
  logger.error(`Erro em ${ctx}`, { err })
  res.status(500).json({ error: 'Erro interno' })
}

/** Valida o :id da rota; responde 400 e devolve null se inválido. */
export function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: 'id inválido' })
    return null
  }
  return id
}
