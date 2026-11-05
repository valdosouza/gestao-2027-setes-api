import { loginEmailBucket } from '@shared/auth/login-email'
import { newCrashRef, recordCrash } from '@shared/errors/crash.repository'
import { ErrorCodes } from '@shared/errors/error-codes'
import { sendMail, opsAlertEmail, isProduction, mailErrorForLog, maskEmail } from '@shared/mailer/mailer'
import logger from '@shared/logger/logger'

// =====================================================================
// Onda 2 do endurecer — o TETO GLOBAL do login é ALARME, nunca bloqueio (D-EA4, Valdo 2026-10-31; `prompt_endurecer_autenticacao.md`).
// Contador em MEMÓRIA do processo de TODA recusa do /auth/login (pega também o e-mail INEXISTENTE, que a tb_user_login_failure — D-EA2 —
// não grava): acima de 100 falhas/min OU de 30 contas distintas com falha em 5 min → linha `[ALARME LOGIN]` no log + `recordCrash` (com
// ref) + e-mail à OPERAÇÃO (`OPS_ALERT_EMAIL`) — tudo no máximo 1 vez a cada 15 min. Sem bloqueio global (bloqueio global = DoS feito por
// nós mesmos): o alarme NUNCA muda a resposta do login.
// Limite conhecido (D-EA4): contador por PROCESSO — vale enquanto o login roda numa instância só (setes-api hoje; auth-api na A2 com
// instância própria — D-AU7); com N instâncias cada uma conta a sua parte. Reinício zera.
// MEMÓRIA COM TETO (plano de testes A6): as falhas por minuto guardam no máximo limiar+1 instantes; as contas distintas guardam no máximo
// limiar+1 chaves de TAMANHO FIXO (`loginEmailBucket` — SHA-256 do e-mail canônico; o corpo aceita 2 MB) — acima do limiar o alarme já
// está decidido e a chave nova não entra (corte na entrada). 1 milhão de e-mails distintos não crescem a estrutura.
// =====================================================================

/** D-EA4: falhas por minuto acima das quais o alarme dispara (a 101ª). */
export const LOGIN_ALARM_FAILURES_PER_MINUTE = 100
/** D-EA4: contas distintas com falha na janela acima das quais o alarme dispara (a 31ª). */
export const LOGIN_ALARM_DISTINCT_ACCOUNTS = 30
/** D-EA4: a janela das contas distintas (5 min). */
export const LOGIN_ALARM_ACCOUNTS_WINDOW_MS = 5 * 60_000
/** D-EA4: no máximo UM alarme (log + crashlytics + e-mail) a cada 15 min. */
export const LOGIN_ALARM_COOLDOWN_MS = 15 * 60_000

const MINUTE_MS = 60_000
const FAILURES_KEPT = LOGIN_ALARM_FAILURES_PER_MINUTE + 1
const ACCOUNTS_KEPT = LOGIN_ALARM_DISTINCT_ACCOUNTS + 1

let clock: () => number = () => Date.now()
/** instantes das últimas falhas (no máximo FAILURES_KEPT), em ordem */
let failures: number[] = []
/** chave de tamanho fixo do e-mail → instante da última falha; ordem de inserção = ordem da última falha (delete + set) */
let accounts = new Map<string, number>()
let lastAlarmAt: number | undefined

/** Testes: relógio controlado e estado zerado. */
export function setLoginWatchClock(fn: () => number): void { clock = fn }
export function resetLoginWatch(): void {
  failures = []
  accounts = new Map()
  lastAlarmAt = undefined
  clock = () => Date.now()
}
/** Testes (A6): o tamanho das estruturas — nunca passa do teto. */
export function loginWatchSize(): { failures: number; accounts: number } {
  return { failures: failures.length, accounts: accounts.size }
}

/** Trabalho em segundo plano (o e-mail à operação) — a resposta do login nunca espera por ele. Testes esperam aqui. */
const pendingAlarms = new Set<Promise<void>>()
export async function waitForPendingLoginAlarms(): Promise<void> {
  while (pendingAlarms.size) await Promise.allSettled([...pendingAlarms])
}

/**
 * Conta UMA recusa do /auth/login (qualquer motivo — inexistente, senha errada, bloqueada, inativa…) e dispara o alarme se passou do
 * limiar. NUNCA lança e NUNCA muda a resposta (A4): o login segue igual com o alarme no ar.
 */
export function recordLoginRefusal(email: string): void {
  try {
    const t = clock()
    failures.push(t)
    if (failures.length > FAILURES_KEPT) failures.shift()
    while (failures.length && failures[0] <= t - MINUTE_MS) failures.shift()

    for (const [key, at] of accounts) {                   // ordem = última falha: poda pela frente
      if (at > t - LOGIN_ALARM_ACCOUNTS_WINDOW_MS) break
      accounts.delete(key)
    }
    const key = loginEmailBucket(email)
    if (accounts.has(key)) { accounts.delete(key); accounts.set(key, t) }
    else if (accounts.size < ACCOUNTS_KEPT) accounts.set(key, t)   // corte na entrada: acima do limiar o alarme já está decidido

    const perMinute = failures.length
    const distinct = accounts.size
    if (perMinute <= LOGIN_ALARM_FAILURES_PER_MINUTE && distinct <= LOGIN_ALARM_DISTINCT_ACCOUNTS) return
    if (lastAlarmAt !== undefined && t - lastAlarmAt < LOGIN_ALARM_COOLDOWN_MS) return
    lastAlarmAt = t
    raiseAlarm(perMinute, distinct, t)
  } catch (err) {
    // o contador é fato secundário: nunca derruba o login (A4)
    logger.error('Contador do alarme do login falhou (D-EA4) — o login segue', { message: (err as Error)?.message ?? String(err) })
  }
}

function raiseAlarm(perMinute: number, distinct: number, at: number): void {
  const ref = newCrashRef()
  const cause = perMinute > LOGIN_ALARM_FAILURES_PER_MINUTE
    ? `${perMinute}+ falhas de login no último minuto (limiar ${LOGIN_ALARM_FAILURES_PER_MINUTE})`
    : `${distinct}+ contas distintas com falha de login em 5 min (limiar ${LOGIN_ALARM_DISTINCT_ACCOUNTS})`
  const when = new Date(at).toISOString()
  logger.error(`[ALARME LOGIN] ${cause} — possível ataque ao login; NADA foi bloqueado (D-EA4) [ref ${ref}]`,
    { ref, failuresLastMinute: perMinute, distinctAccounts5min: distinct, at: when })
  void recordCrash({
    ref, code: ErrorCodes.INTERNAL, statusCode: 401, origen: 'API auth/login (alarme D-EA4)',
    institutionId: 0, userId: 0, message: `[ALARME LOGIN] ${cause}`,
  })
  const to = opsAlertEmail()
  if (!to) {
    // fora de produção vazio = só log (D-EA4); em produção o boot já recusou subir sem ele (`assertOpsAlertReady`)
    if (isProduction()) logger.error('[ALARME LOGIN] sem OPS_ALERT_EMAIL válido — e-mail à operação NÃO enviado', { ref })
    return
  }
  const job: Promise<void> = sendMail({
    to,
    subject: `Setes — [ALARME LOGIN] ${cause} [ref ${ref}]`,
    text: `[ALARME LOGIN] ${cause}, em ${when} (UTC). Nenhum bloqueio global foi aplicado — o limite por conta segue valendo. `
      + `Confira o log do setes-api pelo ref ${ref}. Próximo alarme no mínimo em 15 min.`,
    html: `<div style="font-family:Arial,sans-serif"><h2>[ALARME LOGIN]</h2><p>${cause}, em ${when} (UTC).</p>`
      + `<p>Nenhum bloqueio global foi aplicado — o limite por conta segue valendo. Confira o log do setes-api pelo ref <strong>${ref}</strong>.</p>`
      + `<p>Próximo alarme no mínimo em 15 min.</p></div>`,
  })
    .catch(err => {
      // A8: falha do SMTP = log; o login segue
      logger.error('[ALARME LOGIN] falha no envio do e-mail à operação', { ref, to: maskEmail(to), ...mailErrorForLog(err) })
    })
    .finally(() => pendingAlarms.delete(job))
  pendingAlarms.add(job)
}
