/**
 * CONFERÊNCIA do catálogo de privilégios fora do boot (D-PV9 — Infra-IA/prompts/prompt_privilegios_interfaces.md). SOMENTE LEITURA
 * (sessão READ ONLY, só SELECT no setes_central): a mesma conferência que o boot faz (`assertPrivilegeCatalog`) — a IGUALDADE da D-PV51,
 * por interface: o registro vivo e ativo (`tb_interface_has_privilege`) contra o que o código opera (a lista à mão ∪ a tabela da guarda
 * por roteador — D-PV14), VISUALIZAR em toda tela, CONFIGURAR em toda interface com config/campo (D-PV25) e os reservados; mais o nome
 * de cada privilégio e a forma das chaves (D-PV42). Use depois de aplicar um seed de privilégios (roteiro do §8 do prompt) ou antes de
 * publicar (o `build-web.ps1` do app para com exit ≠ 0 — D-PV16).
 *
 *   npx tsx --require tsconfig-paths/register scripts/check-privilege-catalog.ts
 *   (worktree sem .env: DOTENV_CONFIG_PATH=<caminho do .env> na frente)
 * Sai com código 1 se houver alarme (o boot, ao contrário, só grita e sobe — D-PV52).
 */
import 'dotenv/config'
import './lib/require-target-env'
import pool from '../src/shared/db/connection'
import router from '../src/gateway/router'
import { listGatedModules } from '../src/shared/auth/module-privilege-gate'
import { readPrivilegeCatalogProblems, privilegeCatalogAlarms } from '../src/shared/auth/assert-privilege-catalog'
import { consumedPrivileges, absentMarkHolds, RESERVED_PRIVILEGES } from '../src/shared/auth/privilege-catalog'

void router                                                     // montar o gateway registra as guardas (a tabela da D-PV14)

pool.on('connection', conn => {
  const raw = conn as unknown as { query: (sql: string, cb: (err: unknown) => void) => void }
  raw.query('SET SESSION TRANSACTION READ ONLY', err => { if (err) { console.error('sem READ ONLY — abortado', err); process.exit(2) } })
})

async function main(): Promise<void> {
  if (listGatedModules().length === 0) { console.error('a tabela da guarda por roteador está vazia — o gateway não montou'); process.exit(2) }
  const consumed = consumedPrivileges()
  const problems = await readPrivilegeCatalogProblems(consumed)
  const alarms = privilegeCatalogAlarms(problems)
  const required = consumed.filter(c => !absentMarkHolds(c))
  // QUAL banco foi conferido (sem credencial) — a publicação mostra o destino real (D-PV16; .env por DOTENV_CONFIG_PATH)
  console.log(`Catálogo conferido em ${process.env.DB_HOST ?? '(sem DB_HOST)'}:${process.env.DB_PORT ?? '(sem DB_PORT)'}`)
  console.log(`Pares operados pelo código: ${consumed.length} (${required.length} exigidos no catálogo, ` +
    `${consumed.length - required.length} ausentes por decisão) · reservados: ${RESERVED_PRIVILEGES.length}`)
  const sorted = [...consumed].sort((a, b) => a.interface.localeCompare(b.interface) || a.privilege.localeCompare(b.privilege))
  for (const c of sorted) {
    const miss = problems.missing.some(m => m.interface === c.interface && m.privilege === c.privilege)
      || (c.privilege === 'VISUALIZAR' && problems.menuWithoutView.includes(c.interface))
      || (c.privilege === 'CONFIGURAR' && problems.configureMissing.includes(c.interface))
    console.log(`  ${absentMarkHolds(c) ? 'AUSENTE (decisão)' : miss ? 'FALTA' : 'ok'}  ${c.interface} × ${c.privilege}  [${c.consumers.join(', ')}]`)
  }
  for (const s of problems.surplus) console.log(`  SOBRA  ${s.interface} × ${s.privilege ?? s.description ?? '?'} (${s.privilegeId})`)
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
