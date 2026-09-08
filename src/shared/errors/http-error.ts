/** Erro de um campo específico no payload de resposta (decisão 20 Fase 2). */
export interface FieldError {
  field:   string
  message: string
  /** Valor ESPERADO quando o erro é de conferência numérica (Q-N3 da negociação,
   *  2026-09-07): a tela preenche/corrige sem fazer parse da prosa da mensagem.
   *  Aditivo — consumidores antigos ignoram. */
  expected?: number
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Campos que causaram o erro — vão no payload `{ error, fields }`. */
    public fields?: FieldError[],
    /** Código do catálogo de erros conhecidos (R8 — error-codes.ts);
     *  vai no payload como `code` e na tb_crashlytics p/ agregação. */
    public code?: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
