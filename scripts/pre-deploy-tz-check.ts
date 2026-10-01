/**
 * PRÉ-CONDIÇÃO DE DEPLOY da regra de tempo (Q-TZ5 + Q-TZ6, Valdo 2026-09-30 —
 * Infra-IA/prompts/prompt_pesquisa_avancada.md §10.3). SOMENTE LEITURA.
 *
 * Q-TZ6: mostra o fuso GLOBAL/SISTEMA do MySQL do ambiente — a premissa da "data de
 *        corte" (Q-TZ3: dado antigo em hora de parede de Brasília) só vale se o banco
 *        rodava em hora de Brasília; se já era UTC, registre a exceção do ambiente.
 * Q-TZ5: lista o que está EM VOO e teria a idade calculada errada na virada (DATETIME
 *        gravado em hora local × NOW() em UTC = 180 min a mais):
 *        - cancelamento de NFS-e pedido sem resposta (K vigente) → viraria N "não consta"
 *        - DPS reservado sem resposta do fisco → viraria tentativa abandonada
 *        - boleto apresentado sem resposta do banco → viraria "envio interrompido"
 *        - chave de ativação/recuperação emitida há pouco → expiraria na hora
 *        Deploy só com tudo ZERADO (ou com o operador ciente de cada item).
 *
 *   npx tsx --require tsconfig-paths/register scripts/pre-deploy-tz-check.ts
 * Sai com código 1 se houver algo em voo.
 */
import 'dotenv/config'
import pool from '../src/shared/db/connection'

const RECENT_MINUTES = 240   // janela que cobre o deslocamento de 3h + a carência de 10 min

async function main(): Promise<void> {
  const [tz] = await pool.query<any[]>(
    `SELECT @@global.time_zone AS globalTz, @@system_time_zone AS systemTz, @@session.time_zone AS sessionTz`)
  console.log('— Q-TZ6: fuso do MySQL deste ambiente')
  console.log(`  global=${tz[0].globalTz}  sistema=${tz[0].systemTz}  sessão da API=${tz[0].sessionTz}`)
  const utcServer = ['+00:00', 'UTC', 'Etc/UTC', 'GMT'].includes(String(tz[0].systemTz)) && String(tz[0].globalTz) !== '-03:00'
  console.log(utcServer
    ? '  ⚠️ servidor JÁ em UTC: o dado antigo deste ambiente NÃO está em hora de Brasília — registre a exceção (Q-TZ3).'
    : '  dado antigo em hora local do servidor — premissa da data de corte (Q-TZ3) vale.')

  let inFlight = 0
  const [insts] = await pool.query<any[]>(
    `SELECT id, schema_name AS schemaName FROM setes_central.tb_institution WHERE deleted = 'N' AND active = 'S'`)
  for (const { id, schemaName } of insts) {
    if (!/^[A-Za-z0-9_]+$/.test(schemaName)) continue
    const s = `\`${schemaName}\``
    const q = async (sql: string): Promise<number> => {
      try { const [r] = await pool.query<any[]>(sql, [id]); return Number(r[0]?.n ?? 0) } catch { return -1 }   // tabela ausente
    }
    const cancelK = await q(
      `SELECT COUNT(*) AS n FROM ${s}.tb_invoice_service_transmission_event e
        WHERE e.tb_institution_id = ? AND e.deleted = 'N' AND e.kind = 'K'
          AND NOT EXISTS (SELECT 1 FROM ${s}.tb_invoice_service_transmission_event x
                           WHERE x.tb_institution_id = e.tb_institution_id AND x.tb_invoice_id = e.tb_invoice_id
                             AND x.terminal = e.terminal AND x.attempt = e.attempt AND x.event > e.event AND x.deleted = 'N')`)
    const dpsInFlight = await q(
      `SELECT COUNT(*) AS n FROM ${s}.tb_invoice_service_transmission t
        WHERE t.tb_institution_id = ? AND t.deleted = 'N' AND t.access_key IS NULL
          AND NOT EXISTS (SELECT 1 FROM ${s}.tb_invoice_service_transmission_event e
                           WHERE e.tb_institution_id = t.tb_institution_id AND e.tb_invoice_id = t.tb_invoice_id
                             AND e.terminal = t.terminal AND e.attempt = t.attempt AND e.deleted = 'N')`)
    const slipInFlight = await q(
      `SELECT COUNT(*) AS n FROM ${s}.tb_bank_slip_registration r
        WHERE r.tb_institution_id = ? AND r.deleted = 'N' AND r.request_code IS NULL
          AND NOT EXISTS (SELECT 1 FROM ${s}.tb_bank_slip_registration_event e
                           WHERE e.tb_institution_id = r.tb_institution_id AND e.tb_bank_slip_id = r.tb_bank_slip_id
                             AND e.attempt = r.attempt AND e.deleted = 'N')`)
    const total = [cancelK, dpsInFlight, slipInFlight].filter(n => n > 0).reduce((a, b) => a + b, 0)
    inFlight += total
    const fmt = (n: number) => (n < 0 ? 'tabela ausente' : String(n))
    console.log(`— Q-TZ5: ${schemaName} (institution ${id})`)
    console.log(`  cancelamento de NFS-e sem resposta (K): ${fmt(cancelK)}`)
    console.log(`  DPS reservado sem resposta do fisco:    ${fmt(dpsInFlight)}`)
    console.log(`  boleto apresentado sem resposta:        ${fmt(slipInFlight)}`)
  }
  const [keys] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n FROM setes_central.tb_user
      WHERE deleted = 'N' AND activation_key IS NOT NULL AND activation_key <> ''
        AND updated_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [RECENT_MINUTES])
  const recentKeys = Number(keys[0]?.n ?? 0)
  inFlight += recentKeys
  console.log(`— Q-TZ5: chaves de ativação/recuperação emitidas nas últimas ${RECENT_MINUTES / 60}h: ${recentKeys}`)

  console.log(inFlight
    ? `\n✗ ${inFlight} item(ns) em voo — resolva (ou aceite ciente) antes do deploy.`
    : '\n✓ nada em voo — deploy da regra de tempo liberado.')
  await pool.end()
  process.exit(inFlight ? 1 : 0)
}

main().catch(async err => { console.error(err); await pool.end(); process.exit(2) })
