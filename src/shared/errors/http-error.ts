/** Erro de um campo específico no payload de resposta (decisão 20 Fase 2). */
export interface FieldError {
  field:   string
  message: string
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Campos que causaram o erro — vão no payload `{ error, fields }`. */
    public fields?: FieldError[]
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
