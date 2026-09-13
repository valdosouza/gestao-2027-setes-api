import { PoolConnection } from 'mysql2/promise'
import pool from './connection'
import logger from '@shared/logger/logger'

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
 *
 * Q-A23 (re-prova adversarial final, Valdo 2026-09-10 "sim"): 1 detentor lento
 * (55 s) + 22 baixas prendiam as 20 conexões do pool no lock wait — leitura
 * `GET /orders` levou 48 s e o 409 só vinha aos 50 s (`innodb_lock_wait_timeout`).
 * Este lock espera no máximo INSTITUTION_LOCK_WAIT_SECONDS (`FOR UPDATE WAIT n`,
 * MariaDB ≥ 10.3 — detectado no boot) e estoura como 1205 → 409 RESOURCE_BUSY
 * pela fronteira (`@shared/db/contention`); o retry de deadlock NÃO reexecuta
 * lock wait (falhar cedo é o objetivo). Sem suporte (MySQL), cai no timeout
 * global — avisado no log.
 */
export const INSTITUTION_LOCK_WAIT_SECONDS = 10

let lockWaitSupported = false

/** Testes / injeção: liga ou desliga o `WAIT n` sem consultar o servidor. */
export function setLockWaitSupported(value: boolean): void { lockWaitSupported = value }
export function isLockWaitSupported(): boolean { return lockWaitSupported }

/** Boot (server.ts): `FOR UPDATE WAIT n` existe em MariaDB ≥ 10.3. */
export async function detectLockWaitSupport(): Promise<boolean> {
  const [rows] = await pool.query<any[]>('SELECT VERSION() AS v')
  const version = String(rows[0]?.v ?? '')
  const m = /^(\d+)\.(\d+)/.exec(version)
  const supported = /mariadb/i.test(version) && !!m
    && (Number(m[1]) > 10 || (Number(m[1]) === 10 && Number(m[2]) >= 3))
  lockWaitSupported = supported
  if (supported) {
    logger.info(`Lock da institution com FOR UPDATE WAIT ${INSTITUTION_LOCK_WAIT_SECONDS} s (${version})`)
  } else {
    logger.warn(`Servidor ${version || 'desconhecido'} sem FOR UPDATE WAIT n — lock da institution espera o innodb_lock_wait_timeout (Q-A23)`)
  }
  return supported
}

export async function lockInstitutionCounters(conn: PoolConnection, institutionId: number): Promise<void> {
  const wait = lockWaitSupported ? ` WAIT ${INSTITUTION_LOCK_WAIT_SECONDS}` : ''
  await conn.query(
    `SELECT id FROM setes_central.tb_institution WHERE id = ? FOR UPDATE${wait}`,
    [institutionId]
  )
}
