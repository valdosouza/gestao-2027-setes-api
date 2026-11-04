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
 * arquivo ou banco) e registra no LOG quem rodou (usuário do SO + host), quando e o id do Super; `tb_user.updated_at` e
 * `tb_user.password_set_at` (D-EA7 — as sessões abertas do Super caem) recebem o instante. Códigos de recuperação abertos do Super morrem
 * com a troca (HMAC amarrado ao hash da senha). Depois de gravar e ANTES de mostrar a senha (D-EA19), AVISA o Super por e-mail (D-RS13 —
 * texto neutro, sem link, sem senha; falha do envio = log, a troca fica).
 * Alvo (D-RS7): com UM Super ativo, implícito; com 2+ ativos, só NOMEADO por `--user-id`/`--email` (sem nome, recusa — nunca escolhe
 * sozinho). RECUSA qualquer conta que não seja Super (vínculo `kind = 'super'` na institution da Setes, vivo) — inclusive admin —, Super
 * inativo, usuário OU vínculo (D-RS14/D-RS16: reativar é ato de outro Super pela tela de Usuários; o script nunca reativa), e Super SEM
 * e-mail de login (D-EA20 — o login é pelo e-mail). Sem `--vai` nada é gravado nem enviado.
 */
import 'dotenv/config'
import os from 'os'
import pool from '@shared/db/connection'
import logger from '@shared/logger/logger'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { detectLockWaitSupport } from '@shared/db/counters'
import { describeMailerConfig, mailerConfigProblems } from '@shared/mailer/mailer'
import {
  listSuperAccounts, resetSuperPasswordTx, generateInitialPassword, hashInitialPassword, maskEmail, pickSuperTarget,
  inactiveTargetExit, setesInstitutionZone, sendSuperResetNotice, NO_LOGIN_EMAIL_EXIT,
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await detectLockWaitSupport()
  const supers = await listSuperAccounts(pool)
  console.log(`Supers vivos na institution da Setes: ${supers.length}`)
  for (const s of supers) console.log(`  id=${s.id}  ativo=${s.active}  login=${maskEmail(s.loginEmail)}`)
  const choice = pickSuperTarget(supers, args)                      // D-RS7 — a regra mora na peça (testada lá)
  if ('refusal' in choice) fail(choice.refusal)
  const target = choice.target
  const operator = `${os.userInfo().username}@${os.hostname()}`

  if (!args.vai) {
    // gate socrático (LOW-2): o operador vê, ANTES do --vai, se o aviso ao Super (D-RS13) vai sair — o script roda fora do boot da API
    const smtpProblems = mailerConfigProblems()
    console.log(`\nE-mail (SMTP) para o aviso ao Super: ${describeMailerConfig()}`
      + (smtpProblems.length ? `\n  ⚠ o aviso NÃO sairia: ${smtpProblems.join('; ')}` : ''))
    // gate adversarial (ADV-RS16-01): o ensaio diz o que o --vai fará — alvo INATIVO é recusado, com a saída real
    if (target.active !== 'S') {
      console.log(`\nENSAIO — nada gravado. Alvo: Super id=${target.id} (${maskEmail(target.loginEmail)}) está INATIVO — o --vai será `
        + `RECUSADO: ${inactiveTargetExit(supers, target)}.`)
      return
    }
    if (!target.loginEmail) {
      console.log(`\nENSAIO — nada gravado. Alvo: Super id=${target.id} está SEM E-MAIL DE LOGIN — o --vai será RECUSADO: ${NO_LOGIN_EMAIL_EXIT}.`)
      return
    }
    console.log(`\nENSAIO — nada gravado. Alvo: Super id=${target.id} (${maskEmail(target.loginEmail)}). Repita com --vai para redefinir a senha.`)
    return
  }
  if (target.active !== 'S') fail(`o Super id=${target.id} está INATIVO — ${inactiveTargetExit(supers, target)}`)
  // D-EA20: sem e-mail de login a senha nova não serve para entrar e o aviso não tem destino — recusa ANTES da transação (o ato reconfere
  // sob a trava)
  if (!target.loginEmail) fail(`o Super id=${target.id} está SEM E-MAIL DE LOGIN — nada gravado: ${NO_LOGIN_EMAIL_EXIT}`)

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
      : verdict.status === 'no-login-email'
        ? `o Super id=${target.id} está SEM E-MAIL DE LOGIN — nada gravado: ${NO_LOGIN_EMAIL_EXIT}`
        : `a conta id=${target.id} deixou de ser Super no meio — nada gravado (D-PV46: só o Super)`)
  }
  // Quem rodou e quando: LOG (sem a senha) — a exceção explícita do PADROES §3.1 fica rastreável pelo instante em tb_user.updated_at.
  const at = new Date()
  logger.warn('D-PV46: senha do Super REDEFINIDA pelo operador', {
    userId: target.id, login: maskEmail(verdict.loginEmail), operator,   // D-EA23: o e-mail que o ATO escolheu (gate ADV-FG-02) at: at.toISOString(), host: os.hostname(), pid: process.pid,
  })
  // D-RS13 + D-EA19 (Valdo 2026-11-01, "(b) Aviso primeiro"): o aviso ao Super sai DEPOIS do COMMIT, FORA do withDeadlockRetry (um aviso
  // por troca gravada) e ANTES de a senha aparecer — o sinal fora da máquina precede a entrega do segredo; fechar o terminal com a senha
  // na tela já não mata o aviso. A peça nunca lança; falha = log, a troca fica. Ctrl+C nesta espera: a senha fica GRAVADA e ninguém a viu
  // — rodar de novo (sai outro aviso). D-EA24 (Valdo 2026-11-01): teto TOTAL de 60 s na espera (os tetos do SMTP — D-RS17 — contam só
  // silêncio: servidor que responde aos poucos prendia o aviso sem fim); estourado, "não confirmado — pode ainda sair" e a senha aparece.
  // gate socrático do delta final: a zona é lida ANTES da promessa dos 60 s, com teto próprio (SUPER_ZONE_CAP_MS — estourado, zona padrão)
  const zone = await setesInstitutionZone(pool)
  console.log('\n Senha redefinida. Enviando o aviso ao Super ANTES de mostrar a senha (no máximo 60 s)…')
  console.log(' Se cancelar agora, a senha fica trocada e desconhecida — basta rodar o script de novo.')
  // D-EA23: o aviso vai ao e-mail de login que o ATO escolheu SOB a trava (o da lista pode ter mudado entre a lista e o ato)
  const noticeTo = { ...target, loginEmail: verdict.loginEmail }
  const notice = await sendSuperResetNotice(noticeTo, at, zone)
  console.log(notice === 'sent'
    ? ` Aviso enviado ao e-mail de login do Super (${maskEmail(noticeTo.loginEmail)}).`
    : notice === 'logged'
      // gate socrático (LOW-2): sem SMTP o aviso NÃO saiu, qualquer que seja o NODE_ENV do processo do operador
      ? ' ⚠ Aviso ao Super NÃO enviado: SMTP ausente — o texto foi só ao log; a senha SEGUE redefinida.'
      : notice === 'unconfirmed'
        // D-EA24: o envio segue em segundo plano — o script só termina quando o servidor de e-mail responder ou desistir
        ? ' ⚠ Aviso ao Super NÃO CONFIRMADO em 60 s (pode ainda sair — o desfecho vai ao log); a senha SEGUE redefinida.'
        : ` ⚠ Aviso ao Super NÃO enviado (${notice === 'no-email' ? 'sem e-mail de login' : 'falha do envio — ver o log'}); a senha SEGUE redefinida.`)

  console.log('\n===================================================================')
  console.log(` Senha INICIAL do Super id=${target.id} (${maskEmail(noticeTo.loginEmail)}) — impressa UMA vez, não fica em lugar nenhum:`)
  console.log(`\n     ${password}\n`)
  console.log(' Entregue ao titular por canal seguro; ele define a própria senha em seguida ("Esqueci minha senha" / troca da senha).')
  console.log(`===================================================================`)
}

main()
  .catch(err => { console.error('✗ falha', err?.code ?? '', err?.message ?? err); process.exitCode = 1 })
  .finally(() => pool.end().catch(() => undefined))
