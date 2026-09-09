import mysql from 'mysql2/promise'
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
})

// Q-G17 (cancelamento de nota, Valdo 2026-09-09): REPEATABLE READ é
// INVARIANTE de todos os gap/range locks da casa — trava D5 em UNIQUE, MAX+1
// FOR UPDATE, numeração pelo índice, leituras travantes do plano. Fixado por
// conexão: um default diferente do servidor (DBA) não desliga nada em
// silêncio. `assertIsolationLevel` confere no boot (server.ts).
pool.on('connection', conn => {
  conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
})

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
