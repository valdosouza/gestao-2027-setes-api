import { createHmac, randomInt, timingSafeEqual } from 'crypto'
import { performance } from 'perf_hooks'
import { PoolConnection } from 'mysql2/promise'
import {
  findUserByEmail, getInstitutionsForUser, UserInstitution, AuthUser,
  lockUserForPasswordReset, countPasswordResetsIssued, nextPasswordResetSeq, insertPasswordReset,
  readCurrentPasswordReset, recordFailedPasswordResetAttempt, markPasswordResetUsed, updatePassword,
  assertPasswordResetSchema, hasRecentPasswordResetNotice, insertPasswordResetNotice, PasswordResetNoticeKind,
} from './auth.repository'
import pool from '@shared/db/connection'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { contentionToHttpError } from '@shared/db/contention'
import { newCrashRef, recordCrash } from '@shared/errors/crash.repository'
import { ErrorCodes } from '@shared/errors/error-codes'
import { InstitutionPayload } from '@shared/types/express'
import { SETES_INSTITUTION_ID } from '@shared/auth/roles'
import {
  signFinalToken as signProductToken, signSelectionToken, verifySelectionToken, deriveProductSecret,
} from '@shared/auth/product-token'
import { SessionContext, getSessionContext } from '@shared/session-context'
import { md5Password } from '@shared/auth/password'
import { HttpError } from '@shared/errors/http-error'
import { sendMail, isMailerConfigured, isProduction } from '@shared/mailer/mailer'
import logger from '@shared/logger/logger'

// D-F13 (F2a, etapa A2): os tokens (final 24h — decisão 19 — e de seleção 5m) são RS256 com `kid`, assinados e
// verificados SÓ por @shared/auth/product-token (marca própria de cada um; HS256/JWT_SECRET aposentados).

export interface LoginResult {
  status:        'ok' | 'select'
  token:         string
  institutions?: UserInstitution[]
  /** Estado de sessão derivado (decisão 17) — só acompanha o token FINAL. */
  context?:      SessionContext
}

/** Token final + bloco context (decisão 17): toda emissão de JWT final
 *  devolve também os fatos derivados de sessão para o app. */
export interface IssuedSession {
  token:   string
  context: SessionContext
}

// MD5 aplicado no backend, nunca na query (decisão 2) — função compartilhada
// com o cadastro de Usuário (@shared/auth/password).
const md5 = md5Password

// 'super' fora da institution da Setes é ignorado (decisão 14)
function resolveRole(link: UserInstitution): string {
  const kind = link.profile ?? 'user'
  if (kind === 'super' && link.institutionId !== SETES_INSTITUTION_ID) return 'user'
  return kind
}

async function signFinalToken(userId: number, link: UserInstitution): Promise<IssuedSession> {
  const payload: InstitutionPayload = {
    institutionId: link.institutionId,
    userId,
    role:          resolveRole(link),
    schemaName:    link.schemaName,
  }
  // JWT segue IDENTIDADE MÍNIMA (invariante da Fase 2); fatos derivados vão
  // FORA do token, no bloco context (decisão 17 — fim das GB_* do Delphi).
  const token   = signProductToken(payload)
  const context = await getSessionContext(payload)
  return { token, context }
}

// Passo 1-3 do fluxo: autentica e decide pela quantidade de institutions
export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await findUserByEmail(email)
  if (!user || !user.password || user.password.toUpperCase() !== md5(password)) {
    throw new HttpError(401, 'Email ou senha inválidos')
  }
  if (user.active !== 'S') throw new HttpError(401, 'Usuário inativo')

  const institutions = await getInstitutionsForUser(user.id)

  if (institutions.length === 0) {
    throw new HttpError(403, 'Usuário sem institution ativa')
  }

  if (institutions.length === 1) {
    const issued = await signFinalToken(user.id, institutions[0])
    return { status: 'ok', token: issued.token, context: issued.context }
  }

  const selectionToken = signSelectionToken(user.id)
  return { status: 'select', token: selectionToken, institutions }
}

// Passo 4: valida o token de seleção e o vínculo antes de emitir o JWT final
export async function selectInstitution(selectionToken: string, institutionId: number): Promise<IssuedSession> {
  let userId: number
  try {
    userId = verifySelectionToken(selectionToken).userId
  } catch {
    throw new HttpError(401, 'Token de seleção inválido ou expirado')
  }
  return issueForInstitution(userId, institutionId)
}

// Passo 5: troca de institution com JWT final válido
export async function switchInstitution(userId: number, institutionId: number): Promise<IssuedSession> {
  return issueForInstitution(userId, institutionId)
}

// Nunca confia no body: revalida o vínculo no banco
async function issueForInstitution(userId: number, institutionId: number): Promise<IssuedSession> {
  const institutions = await getInstitutionsForUser(userId)
  const link = institutions.find(i => i.institutionId === institutionId)
  if (!link) throw new HttpError(403, 'Usuário sem vínculo ativo com esta institution')
  return signFinalToken(userId, link)
}

// ---------------------------------------------------------------------
// Recuperação e alteração de senha (fluxo do weberpsetes) — o PEDIDO DE TROCA DE SENHA
// (Q-PV38/D-PV13, 2026-10-18 — Infra-IA/prompts/prompt_privilegios_interfaces.md §13; sql/67; parecer do guardião).
// Uma linha por código emitido; vale só o de MAIOR seq, não usado, dentro do prazo e abaixo do teto de tentativas
// erradas. O código nunca é guardado: só o HMAC de user:seq:hash da senha:e-mail de login:código — trocar a senha
// ou o e-mail de login (por qualquer caminho) invalida o código aberto sem chamada de revogação.
// ---------------------------------------------------------------------

export const PASSWORD_RESET_TTL_MINUTES = 15
/** Tentativas ERRADAS que um código aguenta; a seguinte — mesmo com o código CERTO — é recusada. Valor: questão do Valdo (Q-RS1). */
export const PASSWORD_RESET_MAX_FAILED_ATTEMPTS = 5
/** Teto DURÁVEL de emissões por CONTA (o e-mail resolve a conta): acima dele o pedido é calado. Valores: Q-RS1. */
export const PASSWORD_RESET_MAX_PER_HOUR = 3
export const PASSWORD_RESET_MAX_PER_DAY  = 10

/** A única recusa do passo 2 — código errado, esgotado, vencido, substituído, usado, conta inexistente ou inativa: NUNCA diga qual. */
export const INVALID_PASSWORD_RESET_CODE = 'Código inválido ou expirado'

/**
 * PISO do tempo de resposta das duas rotas públicas de senha (gate adversarial da Q-PV38, MEDIUM): a conta existente abre transação
 * (trava + leituras + COMMIT da tentativa errada) e a inexistente para na busca — mesma 401, tempos diferentes = oráculo de existência.
 * Toda resposta (sucesso ou recusa, conta existente ou não) espera até o piso; o trabalho real (dezenas de ms) fica escondido nele.
 * Limite conhecido: com o banco sob carga a ponto de a conta existente passar do piso, a diferença volta a aparecer.
 */
export const PASSWORD_RESET_RESPONSE_FLOOR_MS = 400
let responseFloorMs = PASSWORD_RESET_RESPONSE_FLOOR_MS
/** Testes: zera ou ajusta o piso (o padrão segue o da produção). */
export function setPasswordResetResponseFloor(ms: number): void { responseFloorMs = ms }

async function withResponseFloor<T>(fn: () => Promise<T>): Promise<T> {
  const started = performance.now()                    // monotônico: ajuste de relógio (NTP) no meio não distorce a espera
  try {
    return await fn()
  } finally {
    const rest = responseFloorMs - (performance.now() - started)
    if (rest > 0) await new Promise(r => setTimeout(r, rest))
  }
}

/** Separação de domínio do segredo derivado da chave de assinatura (A-RS2 — HKDF da chave JWT, Q-RS3; trocar a versão invalida os códigos abertos). */
const PASSWORD_RESET_SECRET_PURPOSE = 'password-reset-code:v1'

function passwordResetHmac(userId: number, seq: number, passwordHash: string | null, loginEmail: string, code: string): string {
  return createHmac('sha256', deriveProductSecret(PASSWORD_RESET_SECRET_PURPOSE))
    .update(`${userId}:${seq}:${passwordHash ?? ''}:${loginEmail}:${code}`)
    .digest('hex')
}

/** Igualdade de HMAC em tempo constante (os dois têm 64 hex; tamanho diferente = não casa). */
function sameHmac(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Transação do pedido de troca de senha: devolve um VEREDITO (o throw fica FORA — a tentativa errada precisa do COMMIT do +1). */
async function inPasswordResetTx<T>(label: string, userId: number, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  return withDeadlockRetry(label, { userId }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const result = await fn(conn)
      await conn.commit()
      return result
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      throw err
    } finally {
      conn.release()
    }
  })
}

/**
 * A resposta é NEUTRA para o cliente, mas a pane não pode sumir (gate socrático da Q-PV38): contenção (lock wait) é carga normal —
 * só aviso; qualquer outro erro depois de achar a conta (banco, chave do HMAC, bug) vira ALARME com ref na tb_crashlytics central.
 */
function alarmNeutral(where: string, userId: number, err: unknown): void {
  if (contentionToHttpError(err)) {
    logger.warn(`${where}: contenção na trava do usuário — resposta neutra`, { userId })
    return
  }
  const ref = newCrashRef()
  // só código/mensagem: o erro do mysql2 carrega `sql` com os parâmetros FORMATADOS (o MD5 da senha nova iria ao log)
  const e = err as { code?: unknown; errno?: unknown; message?: unknown } | null
  logger.error(`${where}: falha depois de achar a conta — resposta NEUTRA ao cliente [ref ${ref}]`,
    { userId, code: e?.code, errno: e?.errno, message: e?.message ?? String(err) })
  void recordCrash({
    ref, code: ErrorCodes.INTERNAL, statusCode: 500, origen: `API ${where} (resposta neutra)`,
    institutionId: 0, userId, message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
}

/** Boot: a tabela (sql/67) e o segredo do HMAC (derivável da chave de assinatura) — sem um dos dois o setes-api NÃO sobe. */
export async function assertPasswordResetReady(): Promise<string> {
  await assertPasswordResetSchema()
  if (!/^[0-9a-f]{64}$/.test(passwordResetHmac(0, 1, null, 'boot', '000000'))) throw new Error('HMAC do pedido de troca de senha fora da forma')
  return 'ok'
}

/**
 * Trabalho em SEGUNDO PLANO ainda em curso — a emissão do código (o recovery responde antes dela — tempo neutro) e o e-mail de
 * aviso ao dono (D-RS4; a resposta da rota sai antes dele). Testes e desligamento esperam aqui.
 */
const pendingJobs = new Set<Promise<void>>()
export async function waitForPendingPasswordResets(): Promise<void> {
  while (pendingJobs.size) await Promise.allSettled([...pendingJobs])
}
/** A borda do trabalho em segundo plano: nada aqui pode virar unhandledRejection (derrubaria o processo inteiro). */
function runInBackground(where: string, userId: number, work: () => Promise<void>): void {
  const job: Promise<void> = work()
    .catch(err => alarmNeutral(where, userId, err))
    .finally(() => pendingJobs.delete(job))
  pendingJobs.add(job)
}

/**
 * D-RS4: toma a vaga do aviso ao dono da conta — no máximo UM por hora por conta — sob a trava do usuário, na MESMA transação que
 * detectou o gatilho (regras 12/13). Devolve a causa quando a vaga foi tomada (o e-mail sai depois do COMMIT, em segundo plano) e
 * `undefined` quando a hora já tem aviso. Tabela própria: não entra no teto de códigos.
 */
async function claimOwnerNotice(
  conn: PoolConnection, where: string, userId: number, kind: PasswordResetNoticeKind,
): Promise<PasswordResetNoticeKind | undefined> {
  // Q-RS10 (gates socrático e adversarial, MEDIUM): o aviso é fato SECUNDÁRIO — a falha dele (GRANT sem INSERT na irmã, CHECK/coluna
  // divergente, banco) NUNCA pode desfazer o fato PRIMÁRIO da mesma transação (o +1 da tentativa errada): sem isto, toda 5ª errada
  // faria rollback do +1 e o código nunca esgotaria. SAVEPOINT em volta da vaga; falha = alarme (nunca silêncio) e a transação segue.
  await conn.query('SAVEPOINT owner_notice')
  try {
    if (await hasRecentPasswordResetNotice(conn, userId)) {
      await conn.query('RELEASE SAVEPOINT owner_notice')
      return undefined
    }
    await insertPasswordResetNotice(conn, userId, kind)
    await conn.query('RELEASE SAVEPOINT owner_notice')
    return kind
  } catch (err) {
    const e = err as { code?: unknown } | null
    if (e?.code === 'ER_LOCK_DEADLOCK') throw err              // 1213 desfaz a transação inteira: cabe ao retry refazê-la toda
    await conn.query('ROLLBACK TO SAVEPOINT owner_notice')
    alarmNeutral(`${where} (aviso ao dono)`, userId, err)       // pane = ref na crashlytics; contenção = aviso — a vaga NÃO foi tomada
    return undefined
  }
}

export type IssueVerdict = 'issued' | 'capped' | 'inactive'
export interface IssueOutcome {
  verdict: IssueVerdict
  /** D-RS4: a vaga do aviso ao dono foi tomada nesta transação (só no `capped`) — mandar o e-mail depois do COMMIT */
  notice?: PasswordResetNoticeKind
}

/**
 * Emite o código novo (substitui o anterior por construção — vale só o maior seq) sob a trava do usuário. No TETO (D-RS4): o pedido
 * é calado e, se a hora ainda não tem aviso, a vaga do aviso ao dono é tomada aqui (kind 'C').
 */
export async function issuePasswordResetCode(conn: PoolConnection, user: AuthUser, code: string): Promise<IssueOutcome> {
  const locked = await lockUserForPasswordReset(conn, user.id)
  if (!locked || locked.active !== 'S') return { verdict: 'inactive' }
  const issued = await countPasswordResetsIssued(conn, user.id)
  if (issued.lastHour >= PASSWORD_RESET_MAX_PER_HOUR || issued.lastDay >= PASSWORD_RESET_MAX_PER_DAY) {
    return { verdict: 'capped', notice: await claimOwnerNotice(conn, 'auth/recovery-password', user.id, 'C') }
  }
  const seq = await nextPasswordResetSeq(conn, user.id)
  await insertPasswordReset(conn, user.id, seq, passwordResetHmac(user.id, seq, locked.password, user.loginEmail, code))
  return { verdict: 'issued' }
}
/** Só o veredito (provas e testes que não olham o aviso). */
export async function createPasswordResetCode(conn: PoolConnection, user: AuthUser, code: string): Promise<IssueVerdict> {
  return (await issuePasswordResetCode(conn, user, code)).verdict
}

export type ConsumeVerdict = 'changed' | 'inactive' | 'none' | 'used' | 'expired' | 'exhausted' | 'wrong'
export interface ConsumeOutcome {
  verdict: ConsumeVerdict
  /** D-RS4: esta tentativa errada ESGOTOU o código e a vaga do aviso ao dono foi tomada (kind 'E') — e-mail depois do COMMIT */
  notice?: PasswordResetNoticeKind
}

/**
 * Julga e CONTA a tentativa sob a trava da linha do usuário (rajadas paralelas não passam do teto): o código vigente certo troca a
 * senha e grava o uso na MESMA transação; o errado soma 1 (o esgotamento é derivado). Esgotado/vencido/usado não somam.
 * A tentativa errada que ESGOTA o código (a N-ésima) toma a vaga do aviso ao dono (D-RS4) — as seguintes (já esgotado) não.
 */
export async function judgePasswordResetCode(
  conn: PoolConnection, user: AuthUser, code: string, newPasswordHash: string,
): Promise<ConsumeOutcome> {
  const locked = await lockUserForPasswordReset(conn, user.id)
  if (!locked || locked.active !== 'S') return { verdict: 'inactive' }
  const current = await readCurrentPasswordReset(conn, user.id, PASSWORD_RESET_TTL_MINUTES)
  if (!current) return { verdict: 'none' }
  if (!current.open) return { verdict: 'used' }
  if (!current.fresh) return { verdict: 'expired' }
  if (current.failedAttempts >= PASSWORD_RESET_MAX_FAILED_ATTEMPTS) return { verdict: 'exhausted' }
  if (!sameHmac(current.codeHmac, passwordResetHmac(user.id, current.seq, locked.password, user.loginEmail, code))) {
    await recordFailedPasswordResetAttempt(conn, user.id, current.seq)
    const exhaustedNow = current.failedAttempts + 1 >= PASSWORD_RESET_MAX_FAILED_ATTEMPTS
    return { verdict: 'wrong', notice: exhaustedNow ? await claimOwnerNotice(conn, 'auth/change-password', user.id, 'E') : undefined }
  }
  await updatePassword(conn, user.id, newPasswordHash)
  await markPasswordResetUsed(conn, user.id, current.seq)
  return { verdict: 'changed' }
}
/** Só o veredito (provas e testes que não olham o aviso). */
export async function consumePasswordResetCode(
  conn: PoolConnection, user: AuthUser, code: string, newPasswordHash: string,
): Promise<ConsumeVerdict> {
  return (await judgePasswordResetCode(conn, user, code, newPasswordHash)).verdict
}

// Passo 1: gera código de 6 dígitos e envia ao e-mail de login GRAVADO — nunca ao texto da requisição: a busca casa pela
// colação _ci (sem acento), e "fulano@gmaíl.com" acharia a conta de "fulano@gmail.com" e mandaria o código ao domínio de
// quem pediu. SMTP via .env; sem SMTP → código no LOG para dev.
// Resposta é SEMPRE genérica (não revela se o email existe): conta inexistente/inativa, conta no TETO de emissões e falha
// do banco depois de achar a conta saem caladas pelo mesmo caminho. TEMPO neutro: a resposta sai depois da MESMA consulta
// (a busca da conta) para quem existe e quem não existe — a emissão (transação com COMMIT) e o e-mail correm em SEGUNDO
// PLANO, depois da resposta (o COMMIT e o SMTP só aconteciam para a conta existente e diziam quem existe).
export async function recoveryPassword(email: string): Promise<void> {
  return withResponseFloor(async () => {
    const user = await findUserByEmail(email)
    if (!user || user.active !== 'S') return // silencioso: sem enumeração de usuários

    runInBackground('auth/recovery-password', user.id, () => issueAndMail(user))
  })
}

async function issueAndMail(user: AuthUser): Promise<void> {
  const code = String(randomInt(100000, 1000000)) // 6 dígitos
  let outcome: IssueOutcome
  try {
    outcome = await inPasswordResetTx('auth/recovery-password', user.id, conn => issuePasswordResetCode(conn, user, code))
  } catch (err) {
    alarmNeutral('auth/recovery-password', user.id, err)
    return
  }
  if (outcome.verdict !== 'issued') {
    logger.warn('Recuperação de senha: pedido calado', {
      userId: user.id, verdict: outcome.verdict, maxPerHour: PASSWORD_RESET_MAX_PER_HOUR, maxPerDay: PASSWORD_RESET_MAX_PER_DAY,
      ownerNotice: outcome.notice ?? 'já avisado nesta hora',
    })
    // D-RS4: o teto foi atingido — a vaga do aviso foi tomada na transação (COMMIT feito); agora o e-mail ao dono
    if (outcome.notice) await sendOwnerNotice(user, outcome.notice)
    return
  }
  await sendRecoveryMail(user.loginEmail, code)
}

async function sendRecoveryMail(email: string, code: string): Promise<void> {
  const changeUrl = process.env.APP_CHANGE_PASSWORD_URL ?? 'http://localhost:5050/#/change-password'
  const configured = isMailerConfigured()           // FORA do try: erro aqui é bug nosso, sobe para a borda do job (alarme), não "falha de envio"
  let delivered = false
  try {
    await sendMail({
      to: email,
      subject: 'Setes — código de recuperação de senha',
      text: `Seu código de recuperação é ${code} (válido por 15 minutos). Acesse ${changeUrl} para definir a nova senha.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#1B3A5F">Recuperação de senha</h2>
          <p>Use o código abaixo para definir sua nova senha no Setes ERP.
             Ele é válido por <strong>15 minutos</strong>.</p>
          <p style="font-size:32px;font-weight:bold;letter-spacing:8px;
                    color:#2E6DA4;text-align:center">${code}</p>
          <p style="text-align:center">
            <a href="${changeUrl}"
               style="background:#3E9B4F;color:#fff;padding:12px 24px;
                      border-radius:24px;text-decoration:none;display:inline-block">
              Definir nova senha</a>
          </p>
          <p style="color:#8793B2;font-size:12px">Se você não solicitou esta
             recuperação, ignore este email — sua senha permanece a mesma.</p>
        </div>`,
    })
    delivered = configured                            // sem SMTP o sendMail só avisa no log — nada foi entregue
  } catch (err) {
    logger.error('Falha no envio do email de recuperação', { email, err })
    // segue: o código está gravado; em dev sai no log abaixo
  }

  // Modo DEV (D-RS5): sem SMTP — ou com o SMTP do dev falhando (gate adversarial, LOW) — o código vai ao LOG, senão iria a lugar
  // nenhum e ainda consumiria o teto. Em PRODUÇÃO o boot já recusou subir sem SMTP (`assertMailerReady`); este cinto garante que,
  // aconteça o que acontecer com o ambiente em execução, o código NUNCA vai ao log de produção (falha do SMTP real = só o erro acima).
  if (!delivered && !isProduction()) {
    logger.info('Código de recuperação de senha (modo dev, SMTP ausente ou com falha)', { email, code })
  }
}

/** Assunto do aviso ao dono (D-RS4) — distinto do e-mail do código; os testes separam os dois por ele. */
export const OWNER_NOTICE_SUBJECT = 'Setes — aviso de segurança da sua conta'

/**
 * D-RS4: o e-mail de AVISO ao dono da conta, pelo e-mail de login GRAVADO. Texto NEUTRO e único para as duas causas (a causa é só
 * forense, no banco): não diz quantas tentativas, não diz se havia código, não traz código nem link de ação — "se não foi você,
 * ignore; o login com a sua senha segue". Sai depois do COMMIT da vaga, em segundo plano; falha do SMTP = log, nunca retentativa
 * (a vaga da hora fica tomada — limite conhecido, como o código). Em dev sem SMTP vai ao log.
 */
async function sendOwnerNotice(user: AuthUser, kind: PasswordResetNoticeKind): Promise<void> {
  // Q-RS12: a frase vale para as DUAS causas — no teto, o pedido seguinte é calado por até 1 h ("peça-o mais tarde"); nunca "basta pedir".
  const text = 'Registramos, há pouco, tentativas de recuperação de senha na sua conta do Setes ERP que não foram concluídas. '
    + 'Se foi você e precisar de um novo código, peça-o mais tarde — por segurança, os pedidos ficam limitados por um tempo. '
    + 'Se não foi você, ignore esta mensagem: nada mudou e o login com a sua senha segue funcionando normalmente. Não respondemos a este e-mail.'
  try {
    await sendMail({
      to: user.loginEmail,
      subject: OWNER_NOTICE_SUBJECT,
      text,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#1B3A5F">Aviso de segurança</h2>
          <p>Registramos, há pouco, tentativas de recuperação de senha na sua conta do Setes ERP que não foram concluídas.</p>
          <p><strong>Se foi você</strong> e precisar de um novo código, peça-o mais tarde — por segurança, os pedidos ficam limitados por um tempo.</p>
          <p><strong>Se não foi você</strong>, ignore esta mensagem: nada mudou e o login com a sua senha segue funcionando normalmente.</p>
          <p style="color:#8793B2;font-size:12px">Não respondemos a este e-mail.</p>
        </div>`,
    })
  } catch (err) {
    logger.error('Falha no envio do aviso ao dono da conta (D-RS4)', { userId: user.id, kind, err })
    return
  }
  if (!isMailerConfigured() && !isProduction()) {
    logger.info('Aviso ao dono da conta (D-RS4, modo dev, SMTP ausente)', { userId: user.id, kind, email: user.loginEmail })
  }
}

// Passo 2: valida email + código e troca a senha (o veredito do judgePasswordResetCode; toda recusa = a MESMA 401).
// A validação do payload vem ANTES de tocar o código (senão o 400 diria "código certo"). Falha do banco depois de achar a
// conta também sai como a recusa neutra (com o erro no log) — a contenção não pode virar oráculo de existência.
// MD5 aplicado AQUI no backend (decisão 2) — o app envia texto puro por HTTPS.
export async function changePassword(email: string, code: string, newPassword: string): Promise<void> {
  if (newPassword.length < 5) throw new HttpError(400, 'A nova senha deve ter pelo menos 5 caracteres')
  return withResponseFloor(() => changePasswordByCode(email, code, newPassword))
}

async function changePasswordByCode(email: string, code: string, newPassword: string): Promise<void> {
  const user = await findUserByEmail(email)
  if (!user || user.active !== 'S') throw new HttpError(401, INVALID_PASSWORD_RESET_CODE)

  let outcome: ConsumeOutcome
  try {
    outcome = await inPasswordResetTx('auth/change-password', user.id,
      conn => judgePasswordResetCode(conn, user, code, md5(newPassword)))
  } catch (err) {
    alarmNeutral('auth/change-password', user.id, err)
    throw new HttpError(401, INVALID_PASSWORD_RESET_CODE)
  }
  if (outcome.verdict === 'changed') return
  // forense: o motivo interno vai ao log (nunca o código); a resposta é uma só
  if (outcome.verdict === 'wrong' || outcome.verdict === 'exhausted') {
    logger.warn('Troca de senha por código recusada', { userId: user.id, verdict: outcome.verdict, ownerNotice: outcome.notice })
  }
  // D-RS4: esta errada ESGOTOU o código e a vaga do aviso foi tomada (COMMIT feito) — o e-mail ao dono sai em SEGUNDO PLANO: a
  // resposta (a mesma 401, dentro do piso) não espera o SMTP, senão o tempo diria que a conta existe
  if (outcome.notice) runInBackground('auth/change-password', user.id, () => sendOwnerNotice(user, outcome.notice!))
  throw new HttpError(401, INVALID_PASSWORD_RESET_CODE)
}
