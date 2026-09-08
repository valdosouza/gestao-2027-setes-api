import logger from '@shared/logger/logger'

/**
 * Reexecuta uma transação inteira em ER_LOCK_DEADLOCK (1213 — o InnoDB
 * desfaz a transação por completo e escolhe uma vítima arbitrária; um
 * SAVEPOINT não sobrevive a isso). Reexecutar do zero é seguro (nada foi
 * gravado) e resolve a corrida na maioria dos casos; qualquer outro erro
 * propaga na hora. Extraído do faturamento (D-G4, 2026-09-04) e usado
 * também pelo módulo bank-slips (D-B4, Rodada 2 do boleto).
 */
export async function withDeadlockRetry<T>(
  label: string, meta: Record<string, unknown>, attempts: number, fn: () => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      if (err?.code !== 'ER_LOCK_DEADLOCK' || attempt >= attempts) throw err
      logger.warn(`Deadlock em ${label} — reexecutando a transação`, { ...meta, attempt })
      await new Promise(r => setTimeout(r, 50 * attempt))
    }
  }
}
