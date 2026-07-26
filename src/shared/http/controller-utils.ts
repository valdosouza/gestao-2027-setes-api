import { Response, Request } from 'express'
import { z } from 'zod'
import { HttpError, FieldError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { newCrashRef, recordCrash } from '@shared/errors/crash.repository'
import logger from '@shared/logger/logger'

/**
 * Utilidades compartilhadas pelos controllers dos módulos de cadastro
 * (padrão simétrico módulo-a-módulo — ver ARQUITETURA_MODULOS_API.md).
 *
 * Contrato de erro (decisão 20 da Fase 2 + Framework de Mensagens R2/R7/R8):
 * `{ error, code?, ref?, fields?: [{ field, message }] }` — o status HTTP
 * discrimina a NATUREZA por construção (400/409 corrigível pelo usuário;
 * 401 sessão; 500 técnica com `ref` rastreável na tb_crashlytics central).
 */

export function handleError(res: Response, err: unknown, ctx: string): void {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.fields ? { fields: err.fields } : {}),
    })
    return
  }

  // ERRO TÉCNICO (R2): ref curto exibido ao usuário + linha na
  // tb_crashlytics central (fire-and-safe) — o suporte rastreia pelo ref.
  const ref = newCrashRef()
  logger.error(`Erro em ${ctx} [ref ${ref}]`, { err })
  const institution = (res.req as Request | undefined)?.institution
  void recordCrash({
    ref,
    code:          ErrorCodes.INTERNAL,
    statusCode:    500,
    origen:        `API ${ctx}`,
    institutionId: institution?.institutionId ?? 0,
    userId:        institution?.userId ?? 0,
    message:       err instanceof Error ? err.message : String(err),
    stack:         err instanceof Error ? err.stack : undefined,
  })
  res.status(500).json({ error: 'Erro interno', code: ErrorCodes.INTERNAL, ref })
}

/** Valida o :id da rota; responde 400 e devolve null se inválido. */
export function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: 'id inválido', code: ErrorCodes.INVALID_ID })
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
    res.status(400).json({
      error: 'Validação falhou',
      code: ErrorCodes.VALIDATION_FAILED,
      fields: zodToFields(parsed.error),
    })
    return null
  }
  return parsed.data
}
