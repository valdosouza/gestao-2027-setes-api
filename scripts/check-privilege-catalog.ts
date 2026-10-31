/**
 * CONFERÊNCIA do catálogo de privilégios fora do boot (D-PV9 — Infra-IA/prompts/prompt_privilegios_interfaces.md). SOMENTE LEITURA
 * (sessão READ ONLY, só SELECT no setes_central): a mesma conferência que o boot faz (`assertPrivilegeCatalog`) — a lista única dos
 * pares (interface, privilégio) que o código consome contra `tb_interface_has_privilege` vivo e ativo, o nome de cada privilégio e
 * VISUALIZAR em toda tela do cliente. Use depois de aplicar um seed de privilégios (roteiro do §8 do prompt) ou antes de publicar.
 *
 *   npx tsx --require tsconfig-paths/register scripts/check-privilege-catalog.ts
 *   (worktree sem .env: DOTENV_CONFIG_PATH=<caminho do .env> na frente)
 * Sai com código 1 se houver alarme (o boot, ao contrário, só grita e sobe).
 */
import 'dotenv/config'
import './lib/require-target-env'
import pool from '../src/shared/db/connection'
import { readPrivilegeCatalogProblems, privilegeCatalogAlarms } from '../src/shared/auth/assert-privilege-catalog'
import { CONSUMED_PRIVILEGES, absentMarkHolds } from '../src/shared/auth/privilege-catalog'

pool.on('connection', conn => {
  const raw = conn as unknown as { query: (sql: string, cb: (err: unknown) => void) => void }
  raw.query('SET SESSION TRANSACTION READ ONLY', err => { if (err) { console.error('sem READ ONLY — abortado', err); process.exit(2) } })
})

async function main(): Promise<void> {
  const problems = await readPrivilegeCatalogProblems()
  const alarms = privilegeCatalogAlarms(problems)
  const required = CONSUMED_PRIVILEGES.filter(c => !absentMarkHolds(c))
  // QUAL banco foi conferido (sem credencial) — a publicação mostra o destino real (D-PV16; .env por DOTENV_CONFIG_PATH)
  console.log(`Catálogo conferido em ${process.env.DB_HOST ?? '(sem DB_HOST)'}:${process.env.DB_PORT ?? '(sem DB_PORT)'}`)
  console.log(`Pares consumidos pelo código: ${CONSUMED_PRIVILEGES.length} (${required.length} exigidos no catálogo, ` +
    `${CONSUMED_PRIVILEGES.length - required.length} ausentes por decisão)`)
  for (const c of CONSUMED_PRIVILEGES) {
    const miss = problems.missing.some(m => m.interface === c.interface && m.privilege === c.privilege)
    console.log(`  ${absentMarkHolds(c) ? 'AUSENTE (decisão)' : miss ? 'FALTA' : 'ok'}  ${c.interface} × ${c.privilege}  [${c.consumers.join(', ')}]`)
  }
  if (alarms.length === 0) console.log('OK — nenhum alarme')
  for (const a of alarms) console.log(a)
  await pool.end()
  process.exit(alarms.length ? 1 : 0)
}

main().catch(async err => {
  console.error('Falha na conferência:', err)
  await pool.end().catch(() => undefined)
  process.exit(2)
})
