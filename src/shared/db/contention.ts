import { HttpError } from '@shared/errors/http-error'

/**
 * Contenção normal do banco NÃO é erro técnico (Q-A3 do cancelamento de nota,
 * Valdo 2026-09-09 — transversal): `ER_LOCK_WAIT_TIMEOUT` (1205) significa
 * "outra operação segura o registro há mais de innodb_lock_wait_timeout" e
 * vira 409 RESOURCE_BUSY em TODOS os módulos (aplicado no handleError e no
 * handler global), sem reexecutar — diferente do deadlock (1213), que
 * `withDeadlockRetry` reexecuta porque o InnoDB desfez a transação sozinho.
 */
export function isLockWaitTimeout(err: unknown): boolean {
  return (err as any)?.code === 'ER_LOCK_WAIT_TIMEOUT'
}

/**
 * L4 (gate socrático da Rodada 3): deadlock (1213) que CHEGA à borda HTTP é
 * "retry esgotado" (withDeadlockRetry, 3×) ou porta sem retry — para o
 * usuário é a mesma contenção: 409 RESOURCE_BUSY, nunca 500 com crashlytics.
 * O retry continua sendo quem REEXECUTA; aqui só se traduz o que sobrou.
 */
export function isDeadlock(err: unknown): boolean {
  return (err as any)?.code === 'ER_LOCK_DEADLOCK'
}

export function contentionToHttpError(err: unknown): HttpError | null {
  if (!isLockWaitTimeout(err) && !isDeadlock(err)) return null
  return new HttpError(409, 'Registro em uso por outra operação — tente novamente', undefined, 'RESOURCE_BUSY')
}
