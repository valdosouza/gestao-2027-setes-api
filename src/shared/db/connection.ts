import mysql from 'mysql2/promise'
import logger from '@shared/logger/logger'
import dotenv from 'dotenv'
dotenv.config()

const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,
  // DECIMAL como number no JSON (senão o driver devolve string "12.00" e
  // quebra o fromJson do app). Precisão ok: nossos DECIMAL são (10,2).
  decimalNumbers: true,
  // Q-TZ1 (Valdo 2026-09-30, prompt_pesquisa_avancada.md §10): INSTANTES em UTC.
  // O driver serializa/lê DATETIME/TIMESTAMP em UTC ('Z') — TEM que concordar com
  // o `SET time_zone = '+00:00'` da sessão abaixo (sem isso um Date JS gravaria a
  // hora de SP como se fosse UTC). Data de NEGÓCIO nunca sai daqui: vem de
  // `todayIn(zona do estabelecimento)` (@shared/time-zone). Colunas DATE são
  // lidas com DATE_FORMAT (neutro); dado gravado antes da troca = data de corte (Q-TZ3).
  timezone: 'Z',
})

// Q-G17 (cancelamento de nota, Valdo 2026-09-09): REPEATABLE READ é
// INVARIANTE de todos os gap/range locks da casa — trava D5 em UNIQUE, MAX+1
// FOR UPDATE, numeração pelo índice, leituras travantes do plano. Fixado por
// conexão: um default diferente do servidor (DBA) não desliga nada em
// silêncio. `assertIsolationLevel` confere no boot (server.ts).
pool.on('connection', conn => {
  // L1 do gate socrático da onda TZ-1: falha do SET numa conexão nova (reconnect) não
  // pode passar em silêncio — a conexão ficaria no fuso/isolamento do servidor.
  const onFail = (what: string) => (err: unknown) =>
    logger.error(`Conexão nova sem ${what} — invariante da casa violada`, { err })
  // o evento entrega a conexão CRUA (estilo callback, apesar do tipo promise): erro vem no callback
  const raw = conn as unknown as { query: (sql: string, cb: (err: unknown) => void) => void }
  raw.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', err => { if (err) onFail('REPEATABLE READ (Q-G17)')(err) })
  raw.query(`SET time_zone = '+00:00'`, err => { if (err) onFail("time_zone '+00:00' (Q-TZ1)")(err) })
})

/** Q-TZ1: confere no boot que a sessão está em UTC (como o REPEATABLE READ). */
export async function assertSessionTimeZoneUtc(): Promise<string> {
  const [rows] = await pool.query<any[]>(`SELECT @@session.time_zone AS tz`)
  const tz = String(rows[0]?.tz ?? '')
  if (tz !== '+00:00') {
    throw new Error(`Fuso da sessão do banco é ${tz || 'desconhecido'} — a casa exige '+00:00' (Q-TZ1)`)
  }
  return tz
}

/**
 * L7 (socrático da Rodada 6): `innodb_rollback_on_timeout` LIGADO faz o lock wait
 * (1205) desfazer a transação INTEIRA em vez de só o statement — e a casa conta com
 * o contrário em dois lugares: o SAVEPOINT da auto-baixa no faturamento (D14/D-G31
 * "manter": contenção pula a baixa e a nota sai) e o 409 RESOURCE_BUSY sem
 * transação perdida. Aviso no boot, ao lado do isolamento; não derruba a API
 * (o comportamento continua correto, só mais caro: a nota inteira falha).
 */
export async function assertRollbackOnTimeoutOff(): Promise<string> {
  const [rows] = await pool.query<any[]>(
    `SHOW VARIABLES WHERE Variable_name = 'innodb_rollback_on_timeout'`
  )
  const value = String(rows[0]?.Value ?? 'desconhecido')
  if (value.toUpperCase() !== 'OFF') {
    logger.warn(
      `innodb_rollback_on_timeout = ${value}: lock wait desfaz a transação inteira — ` +
      'o savepoint da baixa automática no faturamento não protege a nota (D-G31)'
    )
  }
  return value
}

export async function assertIsolationLevel(): Promise<string> {
  // MariaDB 10.x expõe tx_isolation; MySQL 8 só transaction_isolation
  const [rows] = await pool.query<any[]>(
    `SHOW VARIABLES WHERE Variable_name IN ('tx_isolation', 'transaction_isolation')`
  )
  const level = String(rows[0]?.Value ?? '')
  if (level !== 'REPEATABLE-READ') {
    throw new Error(`Nível de isolamento da conexão é ${level || 'desconhecido'} — a casa exige REPEATABLE-READ (Q-G17)`)
  }
  return level
}

export async function getConnection(schemaName: string) {
  const conn = await pool.getConnection()
  await conn.query(`USE \`${schemaName}\``)
  return conn
}

export default pool
