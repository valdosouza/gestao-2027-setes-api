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
 *        - chave de ativação/recuperação emitida há pouco → expiraria na hora (LEGADO `tb_user.activation_key`: desde a Q-PV38 o
 *          código vive em `setes_central.tb_user_password_reset`, que nasceu em UTC — sem transição de fuso, fora desta conferência;
 *          o sql/67 limpa a activation_key, então esta contagem só acusa resto da forma antiga)
 *        Deploy só com tudo ZERADO (ou com o operador ciente de cada item).
 * F2a (D-F110, §22.5 item 14): depois da virada as tabelas fiscais do ERP são ORIGEM CONGELADA — a leitura aqui é histórica e
 *        continua válida (o ATO da virada recusa virar com tentativa viva na origem, então elas ficam em 0); o que está em voo no
 *        fisco passa a morar no fiscal_api, que nasceu em UTC (sem transição de fuso).
 *
 * D-RS5 (2026-10-20, recuperação de senha): confere o SMTP do ambiente — configuração completa (`mailerConfigProblems`) e a
 *        conexão REAL (EHLO/STARTTLS/AUTH, sem enviar nada — `verifyMailerConnection`). Em PRODUÇÃO (NODE_ENV=production)
 *        SMTP ausente/incompleto/sem resposta é item BLOQUEANTE (o boot do setes-api também recusaria subir); fora de
 *        produção é só aviso (modo dev: o código vai ao log). A senha nunca é impressa.
 *
 *   npx tsx --require tsconfig-paths/register scripts/pre-deploy-tz-check.ts
 * Sai com código 1 se houver algo em voo.
 */
import 'dotenv/config'
import pool from '../src/shared/db/connection'
import { isMailerConfigured, isProduction, mailerConfigProblems, verifyMailerConnection, nodeEnvWarning } from '../src/shared/mailer/mailer'

// janela sobre updated_at gravado em hora local × NOW() UTC: ~1h efetiva no dado antigo — cobre o TTL de 15 min das chaves
const RECENT_MINUTES = 240

async function main(): Promise<void> {
  const [tz] = await pool.query<any[]>(
    `SELECT @@global.time_zone AS globalTz, @@system_time_zone AS systemTz, @@session.time_zone AS sessionTz`)
  console.log('— Q-TZ6: fuso do MySQL deste ambiente')
  console.log(`  global=${tz[0].globalTz}  sistema=${tz[0].systemTz}  sessão da API=${tz[0].sessionTz}`)
  // MEDIUM do adversarial: o GLOBAL decide; o sistema operacional só vale quando o global é SYSTEM
  const UTC_NAMES = ['+00:00', 'UTC', 'Etc/UTC', 'GMT', 'Z']
  const effective = String(tz[0].globalTz) === 'SYSTEM' ? String(tz[0].systemTz) : String(tz[0].globalTz)
  console.log(`  fuso efetivo do servidor = ${effective}`)
  const utcServer = UTC_NAMES.includes(effective)
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
      try { const [r] = await pool.query<any[]>(sql, [id]); return Number(r[0]?.n ?? 0) }
      catch (err: any) {
        if (err?.code === 'ER_NO_SUCH_TABLE') return -1                     // tabela ausente
        throw err                                                           // LOW: SQL quebrado nunca vira luz verde
      }
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

  // D-RS5: o SMTP do ambiente — em produção, OBRIGATÓRIO e respondendo; fora dela, aviso.
  inFlight += await checkMailer()

  console.log(inFlight
    ? `\n✗ ${inFlight} item(ns) em voo — resolva (ou aceite ciente) antes do deploy.`
    : '\n✓ nada em voo — deploy da regra de tempo liberado.')
  await pool.end()
  process.exit(inFlight ? 1 : 0)
}

/**
 * D-RS5: devolve 1 quando o SMTP bloqueia o deploy (só em produção: ausente, incompleto ou sem resposta), 0 nos demais casos.
 * Nunca imprime a senha; não envia e-mail (só abre a conexão e autentica).
 */
async function checkMailer(): Promise<number> {
  const prod = isProduction()
  console.log(`— D-RS5: SMTP do ambiente (${prod ? 'NODE_ENV=production — OBRIGATÓRIO' : 'fora de produção — aviso'})`)
  const envWarning = nodeEnvWarning()
  if (envWarning) console.log(`  ⚠️ ${envWarning}`)
  if (!isMailerConfigured()) {
    console.log(prod
      ? '  ✗ SMTP ausente: o boot do setes-api RECUSARIA subir — preencha SMTP_* no .env vivo (valores do Valdo) antes do deploy.'
      : '  ⚠️ SMTP ausente — modo dev: o código de recuperação vai ao LOG.')
    return prod ? 1 : 0
  }
  const problems = mailerConfigProblems()
  if (problems.length) {
    console.log(`  ${prod ? '✗' : '⚠️'} configuração incompleta: ${problems.join('; ')}`)
    return prod ? 1 : 0
  }
  const verified = await verifyMailerConnection()
  console.log(verified.ok ? `  ✓ conexão e autenticação ok — ${verified.detail}` : `  ${prod ? '✗' : '⚠️'} SMTP sem resposta: ${verified.detail}`)
  return verified.ok || !prod ? 0 : 1
}

main().catch(async err => { console.error(err); await pool.end(); process.exit(2) })
