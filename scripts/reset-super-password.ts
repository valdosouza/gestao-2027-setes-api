/**
 * D-PV46 (Valdo, 2026-10-20 — fecha a Q-PV54 = (a)): SENHA PERDIDA DO SUPER = procedimento do OPERADOR, exceção explícita e
 * documentada (nenhuma porta HTTP; a recuperação por e-mail — Q-PV38 — continua valendo também para o Super; este script é a saída
 * quando o e-mail não resolve). Roda NO SERVIDOR, com o `.env` do destino (DB_* e JWT_* do ambiente).
 *
 *   npx tsx --require tsconfig-paths/register scripts/reset-super-password.ts                      # ENSAIO: lista o(s) Super(s)
 *   npx tsx --require tsconfig-paths/register scripts/reset-super-password.ts --vai                # 1 Super: redefine a senha dele
 *   npx tsx --require tsconfig-paths/register scripts/reset-super-password.ts --user-id 7 --vai    # vários: escolha pelo id…
 *   npx tsx --require tsconfig-paths/register scripts/reset-super-password.ts --email x@y --vai    # …ou pelo e-mail de login
 *
 * O que faz com `--vai` (núcleo em `src/modules/auth/super-password-reset.ts`): gera senha inicial ALEATÓRIA (16 caracteres), grava com
 * o MESMO hash do login (md5Password) sob a trava da linha do usuário em tb_user, imprime a senha UMA vez na saída padrão (nunca em log,
 * arquivo ou banco) e registra no LOG quem rodou (usuário do SO + host), quando e o id do Super; `tb_user.updated_at` recebe o instante.
 * Códigos de recuperação abertos do Super morrem com a troca (HMAC amarrado ao hash da senha).
 * RECUSA qualquer conta que não seja Super (vínculo `kind = 'super'` na institution da Setes, vivo) — inclusive admin — e Super inativo
 * (reativar é ato de outro Super pela tela de Usuários). Sem `--vai` nada é gravado.
 */
import 'dotenv/config'
import os from 'os'
import pool from '@shared/db/connection'
import logger from '@shared/logger/logger'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { detectLockWaitSupport } from '@shared/db/counters'
import {
  listSuperAccounts, resetSuperPasswordTx, generateInitialPassword, hashInitialPassword, maskEmail, SuperAccount,
} from '@modules/auth/super-password-reset'

interface Args { vai: boolean; userId?: number; email?: string }

function parseArgs(argv: string[]): Args {
  const args: Args = { vai: false }
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // gate adversarial (INFO): argumento repetido NÃO vence em silêncio; `--user-id` só dígitos (nada de `1e1`, `1.5`, `0x10`)
    if (seen.has(a)) fail(`argumento repetido: ${a}`)
    seen.add(a)
    if (a === '--vai') args.vai = true
    else if (a === '--user-id') {
      const raw = String(argv[++i] ?? '')
      if (!/^[1-9]\d{0,9}$/.test(raw)) fail('--user-id exige um inteiro positivo em dígitos (ex.: --user-id 7)')
      args.userId = Number(raw)
    }
    else if (a === '--email') { args.email = String(argv[++i] ?? '').trim(); if (!args.email) fail('--email exige o e-mail de login') }
    else fail(`argumento desconhecido: ${a}`)
  }
  if (args.userId !== undefined && args.email !== undefined) fail('use --user-id OU --email, não os dois')
  return args
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(2)
}

/**
 * Escolha do alvo. A exceção é MÍNIMA (parecer do guardião, D-PV46 — complemento "um Super define a senha do outro pela tela"):
 * com 2+ Supers ATIVOS o script RECUSA e aponta a tela de Usuários do Super (Q-RS7: cobrir "os dois perderam" é decisão do Valdo).
 * Com um só ativo: implícito; `--user-id`/`--email` servem para nomear o alvo quando há outros Supers INATIVOS na lista.
 */
function pickTarget(supers: SuperAccount[], args: Args): SuperAccount {
  const active = supers.filter(s => s.active === 'S')
  if (active.length > 1) {
    fail(`há ${active.length} Supers ATIVOS (ids ${active.map(s => s.id).join(', ')}): a senha de um é definida pelo OUTRO na tela de `
      + 'Usuários do Super (D-PV46) — este script só serve quando não resta outro Super ativo')
  }
  if (args.userId !== undefined) {
    const s = supers.find(x => x.id === args.userId)
    return s ?? fail(`o usuário ${args.userId} não é Super (ou está excluído) — este script só redefine a senha do Super (D-PV46)`)
  }
  if (args.email !== undefined) {
    const wanted = args.email.toLowerCase()
    const found = supers.filter(x => (x.loginEmail ?? '').toLowerCase() === wanted)
    if (found.length !== 1) fail('nenhum Super (ou mais de um) com o e-mail de login informado — este script só redefine a senha do Super (D-PV46)')
    return found[0]
  }
  if (active.length === 1) return active[0]
  return fail(supers.length === 0
    ? 'nenhum Super vivo na institution da Setes — nada a fazer'
    : `nenhum Super ATIVO (${supers.length} inativo(s)): nomeie o alvo com --user-id <id> ou --email <login> (o script não reativa)`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await detectLockWaitSupport()
  const supers = await listSuperAccounts(pool)
  console.log(`Supers vivos na institution da Setes: ${supers.length}`)
  for (const s of supers) console.log(`  id=${s.id}  ativo=${s.active}  login=${maskEmail(s.loginEmail)}`)
  const target = pickTarget(supers, args)
  const operator = `${os.userInfo().username}@${os.hostname()}`

  if (!args.vai) {
    console.log(`\nENSAIO — nada gravado. Alvo: Super id=${target.id} (${maskEmail(target.loginEmail)}). Repita com --vai para redefinir a senha.`)
    return
  }
  if (target.active !== 'S') fail(`o Super id=${target.id} está INATIVO — reative-o pela tela de Usuários (outro Super) antes; este script não reativa`)

  const password = generateInitialPassword()
  const verdict = await withDeadlockRetry('reset-super-password', { userId: target.id }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const v = await resetSuperPasswordTx(conn, target.id, hashInitialPassword(password))
      if (v.status !== 'reset') { await conn.rollback(); return v }
      await conn.commit()
      return v
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      throw err
    } finally {
      conn.release()
    }
  })

  if (verdict.status !== 'reset') {
    fail(verdict.status === 'inactive'
      ? `o Super id=${target.id} ficou inativo no meio — nada gravado`
      : `a conta id=${target.id} deixou de ser Super no meio — nada gravado (D-PV46: só o Super)`)
  }
  // Quem rodou e quando: LOG (sem a senha) — a exceção explícita do PADROES §3.1 fica rastreável pelo instante em tb_user.updated_at.
  logger.warn('D-PV46: senha do Super REDEFINIDA pelo operador', {
    userId: target.id, login: maskEmail(target.loginEmail), operator, at: new Date().toISOString(), host: os.hostname(), pid: process.pid,
  })
  console.log('\n===================================================================')
  console.log(` Senha INICIAL do Super id=${target.id} (${maskEmail(target.loginEmail)}) — impressa UMA vez, não fica em lugar nenhum:`)
  console.log(`\n     ${password}\n`)
  console.log(' Entregue ao titular por canal seguro; ele define a própria senha em seguida ("Esqueci minha senha" / troca da senha).')
  console.log(`===================================================================`)
}

main()
  .catch(err => { console.error('✗ falha', err?.code ?? '', err?.message ?? err); process.exitCode = 1 })
  .finally(() => pool.end().catch(() => undefined))
