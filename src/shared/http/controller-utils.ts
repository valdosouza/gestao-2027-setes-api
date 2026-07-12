import { Response, Request } from 'express'
import { z } from 'zod'
import { HttpError, FieldError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

/**
 * Utilidades compartilhadas pelos controllers dos módulos de cadastro
 * (padrão simétrico módulo-a-módulo — ver ARQUITETURA_MODULOS_API.md).
 *
 * Erro de validação SEMPRE no formato por campo (decisão 20 da Fase 2):
 * `{ error, fields: [{ field, message }] }` — o app usa `field` para
 * apontar o campo rejeitado.
 */

export function handleError(res: Response, err: unknown, ctx: string): void {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(
      err.fields ? { error: err.message, fields: err.fields } : { error: err.message }
    )
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

/** Converte os issues do Zod para o formato por campo da decisão 20. */
export function zodToFields(error: z.ZodError): FieldError[] {
  return error.issues.map(issue => ({
    field:   issue.path.join('.') || '(body)',
    message: issue.message,
  }))
}

/**
 * Valida o body com o schema Zod; responde 400 `{ error, fields[] }` e
 * devolve null se inválido. Uso: `const body = parseBody(dto, req, res);
 * if (body === null) return`.
 */
export function parseBody<S extends z.ZodTypeAny>(
  schema: S, req: Request, res: Response
): z.infer<S> | null {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validação falhou', fields: zodToFields(parsed.error) })
    return null
  }
  return parsed.data
}
