import { PoolConnection } from 'mysql2/promise'
import logger from '@shared/logger/logger'

/**
 * Trecho ISOLADO dentro de uma transação (peça irmã de `deadlock-retry` e
 * `contention`). Nasceu da extração dos automatismos do faturamento
 * (fase Primeiro Cliente, Onda 1): a mesma receita estava inline duas vezes
 * em `billing.repository`, com uma sutileza que é fácil perder ao copiar.
 *
 * A sutileza: ER_LOCK_DEADLOCK (1213) desfaz a transação INTEIRA no InnoDB —
 * o savepoint já não existe. Quando o `ROLLBACK TO SAVEPOINT` também falha,
 * não há transação para continuar: o erro ORIGINAL propaga e derruba a
 * operação toda. Só quando o rollback FUNCIONA é que o trecho pode ser
 * tratado como opcional (ER_LOCK_WAIT_TIMEOUT 1205, bug de código): desfaz-se
 * o pedaço e o resto da transação segue vigente.
 *
 * Devolve o resultado de `fn`, ou `null` quando o trecho foi desfeito.
 */
export async function runIsolated<T>(
  conn: PoolConnection,
  name: string,
  label: string,
  fn: () => Promise<T>,
  context: Record<string, unknown> = {}
): Promise<T | null> {
  // O nome vai interpolado no SQL (savepoint não aceita placeholder): só
  // identificador simples entra, para a assinatura pública não virar porta.
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(name)) {
    throw new Error(`Nome de savepoint inválido: ${name}`)
  }
  await conn.query(`SAVEPOINT ${name}`)
  try {
    return await fn()
  } catch (err) {
    try {
      await conn.query(`ROLLBACK TO SAVEPOINT ${name}`)
    } catch (rollbackErr) {
      logger.error(`Transação perdida em ${label} — operação NÃO concluída`, {
        ...context, err, rollbackErr,
      })
      throw err
    }
    logger.error(`${label} falhou — trecho desfeito, a transação segue`, { ...context, err })
    return null
  }
}
