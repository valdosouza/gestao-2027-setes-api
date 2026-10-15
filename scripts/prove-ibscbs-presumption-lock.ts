/**
 * PROVA da trava da PRESUNÇÃO do serviço (fase IBS/CBS, IB-2 — D-IB70; gate socrático da IB-2; PADROES §9 regra 8) em
 * SCHEMA DESCARTÁVEL `setes_ib2_lock_<pid>` (cópias VAZIAS de tb_product, tb_service e tb_service_ibscbs do schema de
 * origem por CREATE TABLE … LIKE; dois serviços A < B sem a peça 1:1 — o estado dos 45 serviços da Setes hoje). Apaga o
 * schema no fim (inclusive em falha); NUNCA escreve no schema de origem.
 *
 * Cenário (os dois lados, na ordem que fecha o ciclo):
 *   conn PUT  : BEGIN · SELECT produto B FOR UPDATE                          (o PUT /services/B começou)
 *   conn FAT  : BEGIN · lê a presunção de A e B com trava compartilhada      (o faturamento chega e espera B)
 *   conn PUT  : INSERT tb_service_ibscbs(B) · COMMIT                         (o PUT classifica B)
 *   (A) forma ANTIGA — UM SELECT com LEFT JOIN travante: o faturamento já travou o INTERVALO da 1:1 ausente de A antes de
 *       esperar B → o INSERT do PUT cai nesse intervalo → ciclo → 1213 (deadlock) para um dos dois.
 *   (B) forma NOVA — `readServicePresumptions` (3 leituras na ordem do PUT): o faturamento espera no produto B SEM ter
 *       tocado a 1:1 → o PUT insere e confirma → o faturamento segue e LÊ a classificação recém-gravada de B.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-ibscbs-presumption-lock.ts [schema-origem=setes_setes]
 */
import pool from '@shared/db/connection'
import { readServicePresumptions } from '@shared/service-ibscbs'

const SOURCE = process.argv[2] ?? 'setes_setes'
const PROBE = `setes_ib2_lock_${process.pid}`
const INST = 1, A = 900001, B = 900002
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const OLD_JOIN = (s: string) =>
  `SELECT p.id, sv.nbs, si.classification_code
     FROM \`${s}\`.tb_product p
     LEFT JOIN \`${s}\`.tb_service sv ON sv.id = p.id AND sv.tb_institution_id = p.tb_institution_id AND sv.deleted = 'N'
     LEFT JOIN \`${s}\`.tb_service_ibscbs si ON si.id = p.id AND si.tb_institution_id = p.tb_institution_id AND si.deleted = 'N'
    WHERE p.tb_institution_id = ? AND p.id IN (?) AND p.deleted = 'N'
    ORDER BY p.id
    LOCK IN SHARE MODE`

async function scenario(label: string, billingRead: (c: any) => Promise<unknown>) {
  const put = await pool.getConnection()
  const fat = await pool.getConnection()
  const outcome: Record<string, string> = {}
  try {
    for (const c of [put, fat]) await c.query(`SET SESSION innodb_lock_wait_timeout = 8`)
    await put.query('START TRANSACTION')
    await put.query(`SELECT id FROM \`${PROBE}\`.tb_product WHERE id = ? AND tb_institution_id = ? FOR UPDATE`, [B, INST])
    await fat.query('START TRANSACTION')
    const billing = billingRead(fat)
      .then(r => { outcome.faturamento = `ok ${JSON.stringify(r)}` })
      .catch((e: any) => { outcome.faturamento = `erro ${e?.errno ?? ''} ${e?.code ?? e?.message}` })
    await sleep(700)   // o faturamento está esperando o produto B
    try {
      await put.query(
        `INSERT INTO \`${PROBE}\`.tb_service_ibscbs (id, tb_institution_id, classification_code, place_indicator_code, created_at, updated_at, deleted)
         VALUES (?, ?, '000001', '100301', NOW(), NOW(), 'N')`, [B, INST])
      await put.query('COMMIT')
      outcome.put = 'ok (classificou e confirmou)'
    } catch (e: any) {
      outcome.put = `erro ${e?.errno ?? ''} ${e?.code ?? e?.message}`
      await put.query('ROLLBACK').catch(() => undefined)
    }
    await billing
    await fat.query('ROLLBACK').catch(() => undefined)
  } finally {
    put.release(); fat.release()
    await pool.query(`DELETE FROM \`${PROBE}\`.tb_service_ibscbs`).catch(() => undefined)
  }
  console.log(`${label}\n    PUT do serviço: ${outcome.put}\n    faturamento:    ${outcome.faturamento}`)
  return outcome
}

async function main() {
  if (!/^setes_[a-z0-9_]+$/.test(SOURCE)) throw new Error(`schema de origem inválido: ${SOURCE}`)
  let ok = true
  try {
    await pool.query(`CREATE DATABASE \`${PROBE}\``)
    for (const t of ['tb_product', 'tb_service', 'tb_service_ibscbs']) {
      await pool.query(`CREATE TABLE \`${PROBE}\`.${t} LIKE \`${SOURCE}\`.${t}`)
    }
    // dois serviços vivos, sem a peça 1:1 (copiados da forma real; só as colunas obrigatórias)
    for (const id of [A, B]) {
      await pool.query(
        `INSERT INTO \`${PROBE}\`.tb_product (id, tb_institution_id, description, kind, deleted) VALUES (?, ?, ?, 'S', 'N')`,
        [id, INST, `Serviço ${id === A ? 'A' : 'B'}`])
      await pool.query(
        `INSERT INTO \`${PROBE}\`.tb_service (id, tb_institution_id, nbs, deleted) VALUES (?, ?, '115021000', 'N')`, [id, INST])
    }

    const old = await scenario('(A) forma ANTIGA — UM SELECT com LEFT JOIN travante',
      c => c.query(OLD_JOIN(PROBE), [INST, [A, B]]).then(([r]: any) => r.length))
    const oldDeadlock = /1213/.test(`${old.put} ${old.faturamento}`)
    console.log(`${oldDeadlock ? 'CONFIRMADO' : 'NÃO REPRODUZIU'} — a forma antiga fecha ciclo com o PUT (1213)`)

    const neu = await scenario('(B) forma NOVA — readServicePresumptions (produto → serviço → 1:1)',
      c => readServicePresumptions(c, PROBE, INST,
        [{ productId: A, field: 'a' }, { productId: B, field: 'b' }], { lock: true })
        .then(rows => rows.map(r => `${r.productId}:${r.classificationCode ?? '—'}`)))
    const newOk = /^ok/.test(neu.put) && /^ok/.test(neu.faturamento) && /900002:000001/.test(neu.faturamento)
    console.log(`${newOk ? 'OK  ' : 'FALHA'} — a forma nova não fecha ciclo: o PUT confirma e o faturamento LÊ a classificação nova de B`)
    ok = newOk
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    await pool.end()
  }
  console.log(ok ? '\nPROVA OK — schema descartável apagado' : '\nPROVA FALHOU — schema descartável apagado')
  process.exit(ok ? 0 : 1)
}

main().catch(async e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
