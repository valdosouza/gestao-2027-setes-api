import { PoolConnection } from 'mysql2/promise'

/**
 * Q-A12 (3ª rodada adversarial do cancelamento de nota, 2026-09-09) — regra 7
 * do PADROES_BANCO §9: quem CUNHA número por MAX+1 trava a linha da
 * institution ANTES dos MAX.
 *
 * Por quê: `SELECT MAX(...) FOR UPDATE` num índice secundário deixa gap lock
 * no supremum — e gap locks são COMPATÍVEIS entre si. N transações passam do
 * MAX juntas com o MESMO número e deadlockam no INSERT (a intenção de inserir
 * espera o gap do vizinho); com 6 aberturas concorrentes o retry de 3× não
 * bastava (47 % de 500 no dev; 50 % em POST /orders com 2). Um lock EXCLUSIVO
 * de UMA linha serializa só os cunhadores da institution, sem tocar quem já
 * está travando pedidos (billing/cancel) — por isso é sempre o PRIMEIRO lock
 * da transação que cunha, nunca no meio.
 */
export async function lockInstitutionCounters(conn: PoolConnection, institutionId: number): Promise<void> {
  await conn.query(
    'SELECT id FROM setes_central.tb_institution WHERE id = ? FOR UPDATE',
    [institutionId]
  )
}
