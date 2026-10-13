import { AsyncLocalStorage } from 'async_hooks'

/**
 * QUEM fez a requisição — fixado UMA vez pelo `authMiddleware` (depois de verificar o token) e lido por quem precisa do autor sem
 * receber o `InstitutionPayload` por parâmetro (o alarme da porta da voz do fisco — D-F151 (= Q-F156 (b), Valdo 2026-10-13): "o alarme
 * leva o usuário da requisição"). Molde do relógio por operação (`@shared/time-zone/operation-clock`, Q-TZ8). Fora de uma requisição
 * autenticada (rotina, script, teste) = null — quem lê decide o padrão. Nunca decide autorização: só identifica o autor no registro.
 */
export interface RequestActor {
  institutionId: number
  userId: number
}

const storage = new AsyncLocalStorage<RequestActor>()

/** Executa [fn] com o autor da requisição fixado em [actor] (inclusive nas continuações assíncronas). */
export function runAsActor<T>(actor: RequestActor, fn: () => T): T {
  return storage.run({ institutionId: actor.institutionId, userId: actor.userId }, fn)
}

/** O autor da requisição corrente (null fora de uma requisição autenticada). */
export function currentActor(): RequestActor | null {
  return storage.getStore() ?? null
}
