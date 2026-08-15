import { HttpError } from '@shared/errors/http-error'

/**
 * Validação do schemaName ANTES de interpolar em SQL (defesa em
 * profundidade — o valor vem do JWT assinado, mas nunca entra em query
 * sem passar aqui). Peça CENTRALIZADA na entrega do módulo de Menus
 * (2026-08-04, objetivo 7 do prompt_modulo_menus.md): antes vivia
 * quadruplicada em core/users/admin/field-config.
 */

const SCHEMA_RE = /^setes_[a-z0-9_]+$/

/** Valida e devolve o schemaName (uso: interpolação em template de query). */
export function assertSchema(schemaName: string): string {
  if (!SCHEMA_RE.test(schemaName)) {
    throw new HttpError(400, `schemaName inválido: ${schemaName}`)
  }
  return schemaName
}

/** Variante void — contrato histórico dos consumidores do field-config. */
export function assertSchemaName(schemaName: string): void {
  assertSchema(schemaName)
}
