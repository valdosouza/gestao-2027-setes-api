import { createHmac, randomInt, timingSafeEqual } from 'crypto'
import { performance } from 'perf_hooks'
import { PoolConnection } from 'mysql2/promise'
import {
  findUserByEmail, getInstitutionsForUser, UserInstitution, AuthUser,
  lockUserCredential, countPasswordResetsIssued, nextPasswordResetSeq, insertPasswordReset,
  readCurrentPasswordReset, recordFailedPasswordResetAttempt, markPasswordResetUsed, updatePassword, rehashPassword,
  assertPasswordResetSchema, hasRecentPasswordResetNotice, insertPasswordResetNotice, PasswordResetNoticeKind,
  countLoginFailuresInWindow, insertLoginFailure, hasRecentLoginBlockNotice, insertLoginBlockNotice, assertLoginLockSchema,
  LOGIN_MAX_FAILURES, LOGIN_FAILURE_WINDOW_MINUTES,
} from './auth.repository'
import { recordLoginRefusal } from './login-watch'
import pool from '@shared/db/connection'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { contentionToHttpError, isLockWaitTimeout } from '@shared/db/contention'
import { newCrashRef, recordCrash } from '@shared/errors/crash.repository'
import { ErrorCodes } from '@shared/errors/error-codes'
import { InstitutionPayload } from '@shared/types/express'
import {
  signFinalToken as signProductToken, signSelectionToken, verifySelectionToken, deriveProductSecret,
} from '@shared/auth/product-token'
import { SessionContext, getSessionContext } from '@shared/session-context'
import { liveSession } from '@shared/access'
import { hashPassword, checkPassword, PasswordCheck } from '@shared/auth/password'
import { passwordProblems, PASSWORD_PROBLEM_MESSAGES } from '@shared/auth/password-policy'
import { HttpError } from '@shared/errors/http-error'
import { sendMail, isMailerConfigured, isProduction, maskEmail, mailErrorForLog, singleMailAddress } from '@shared/mailer/mailer'
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

// D-EA9 (Onda 4): o hash da senha é a peça @shared/auth/password (scrypt; MD5 só como LEGADO conferido) — aplicado no backend, nunca na
// query, e SEMPRE fora da trava da linha do usuário (assíncrono, centenas de ms).

/**
 * H2: a conferência pela peça, com ALARME quando o valor gravado está fora das formas aceitas (texto puro, scrypt malformado, peso fora da
 * lista) — a peça não calcula e diz `invalid`; aqui vira recusa neutra (não confere) + alarme com ref, nunca 500. Nunca loga o valor.
 */
async function checkStoredPassword(where: string, userId: number, plain: string, stored: string | null): Promise<PasswordCheck> {
  const check = await checkPassword(plain, stored)
  if (check.form === 'invalid' && stored) {
    alarmNeutral(where, userId, new Error('hash de senha gravado fora das formas aceitas (D-EA9: scrypt da peça ou MD5 legado) — recusa neutra'))
  }
  return check
}

// 'super' fora da institution da Setes é ignorado (decisão 14) — quem decide é a `vw_user_link` (o perfil chega pronto: costura A1)
function resolveRole(link: UserInstitution): string {
  return link.profile ?? 'user'
}

/** A assinatura pura (sem banco) — pode rodar com a trava da linha do usuário segura (ajuste (d) do parecer §P.3). */
function signFinalPayload(userId: number, link: UserInstitution): { token: string; payload: InstitutionPayload } {
  const payload: InstitutionPayload = {
    institutionId: link.institutionId,
    userId,
    role:          resolveRole(link),
    schemaName:    link.schemaName,
  }
  // JWT segue IDENTIDADE MÍNIMA (invariante da Fase 2); fatos derivados vão
  // FORA do token, no bloco context (decisão 17 — fim das GB_* do Delphi).
  return { token: signProductToken(payload), payload }
}

async function signFinalToken(userId: number, link: UserInstitution): Promise<IssuedSession> {
  const { token, payload } = signFinalPayload(userId, link)
  const context = await getSessionContext(payload)
  return { token, context }
}

// ---------------------------------------------------------------------
// LOGIN — Ondas 1+2 do endurecer (`Infra-IA/prompts/prompt_endurecer_autenticacao.md`; D-EA1/D-EA2/D-EA3/D-EA6/D-EA11/D-EA14/D-EA15,
// A-EA1…A-EA8; protocolo do parecer do guardião §P.3; sql/74).
//   D-EA1: 10 erradas em 15 min (janela DESLIZANTE) bloqueiam a CONTA até a falha mais velha envelhecer — sem botão; durante o bloqueio
//          até a senha CERTA recebe a mesma recusa. Vale para todo perfil, Super inclusive (o script do Super NÃO desbloqueia).
//   D-EA6: UMA resposta — 401 "Email ou senha inválidos" — para senha errada, e-mail inexistente, conta sem credencial, usuário inativo,
//          sem estabelecimento ativo, conta bloqueada e contenção; o motivo real vai só ao LOG (D-EA11). A senha CERTA em conta
//          inativa/sem vínculo NÃO conta como falha.
//   Piso de tempo SÓ nas recusas (A-EA4): todo 401 sai depois de LOGIN_REFUSAL_FLOOR_MS; o 200 sai sem esperar (o token já o distingue).
// O PROTOCOLO (A-EA2 — parecer §P.3):
//   1. conta = findUserByEmail (fora de transação); sem conta ou sem credencial (NULL/'') → recusa, nenhuma transação (A-EA3)
//   2. PRÉ-FILTRO sem trava: falhas na janela (consistente, autocommit) ≥ 10 → recusa SEM conferir a senha e SEM travar
//   3. a senha é conferida FORA da trava (scrypt — Onda 4/D-EA9: o hash nunca segura a linha nem a conexão; certa em formato/peso antigo =
//      o hash novo também aqui, e a regravação por compare-and-set sob a trava, só no admitido, sem tocar password_set_at)
//   4. transação: trava da linha do usuário (1º statement, WAIT 5) → o hash travado ≠ o conferido = reconfere contra o travado → a
//      contagem REFEITA sob a trava (≥ 10 = recusa sem gravar e sem olhar o veredito) → errada: INSERT da falha e, se ela leva a janela a
//      10, a vaga do aviso ao dono sob SAVEPOINT (D-EA15/D-RS10) → certa: inativo/sem vínculo = recusa sem gravar; senão o token é
//      ASSINADO com a trava segura → COMMIT. O caminho CERTO também passa pela trava (senão o 1205 viraria palpite grátis).
//   1205 (lock wait) → a MESMA recusa, nada gravado, aviso de contenção no log; 1213 reexecuta (withDeadlockRetry) e, esgotado, a mesma
//   recusa + alarme com ref.
// Conhecimento negativo: o julgamento NÃO filtra as falhas por `password_set_at` — senão trocar a senha desbloquearia (contra a D-EA1).
// D-UC12 (o login é o aceite do convidado) ainda não existe no `main`: quando entrar, roda só DEPOIS da admissão (passo 4, caminho certo)
// e ANTES da contagem de vínculos ativos — nunca em paralelo com esta onda (D-EA10).
// ---------------------------------------------------------------------

/** D-EA6: a ÚNICA recusa do login. */
export const LOGIN_REFUSED_MESSAGE = 'Email ou senha inválidos'

/**
 * Piso do tempo das RECUSAS do login (A-EA4): a conta inexistente para na busca; a existente faz pré-filtro, transação e COMMIT da falha —
 * mesma 401, tempos diferentes diriam quem existe. D-EA43 (Valdo 2026-11-07, "(a) subir"): 700 ms — acima do p99 de UMA conferência
 * scrypt no peso vigente medida no dev (496 ms, H8); a conta inexistente NÃO calcula hash falso (D-EA9/H7). Valor revisto pela medição no
 * SERVIDOR REAL (D-EA17/H11). Limite conhecido: com muitas conferências ao mesmo tempo (20 juntas = p99 3,3 s no dev) a conta existente
 * passa do piso e a diferença volta a aparecer.
 */
export const LOGIN_REFUSAL_FLOOR_MS = 700
let loginRefusalFloorMs = LOGIN_REFUSAL_FLOOR_MS
/** Testes: zera ou ajusta o piso (o padrão segue o da produção). */
export function setLoginRefusalFloor(ms: number): void { loginRefusalFloorMs = ms }

/** D-EA11: o motivo INTERNO da recusa — só ao log, nunca à resposta. */
export type LoginRefusalReason =
  'senha errada' | 'inexistente' | 'sem credencial' | 'inativo' | 'sem vínculo' | 'bloqueado' | 'contenção' | 'falha interna'

export interface LoginMeta {
  /** IP de quem pediu (D-EA11; até o `trust proxy` da Onda 4 do deploy, atrás de proxy é o do PROXY — D-RS2) */
  ip?: string
}

/**
 * D-EA11: UMA linha de log por recusa — e-mail DIGITADO mascarado (D-EA21), IP, motivo interno, instante; NUNCA a senha nem o e-mail
 * inteiro. O `userId` entra quando a conta foi achada (com o e-mail mascarado, duas contas `v***@x` seriam indistinguíveis — o mesmo
 * motivo da D-EA21 no log do código em dev). A recusa também conta no alarme global (D-EA4 — inclusive o e-mail inexistente).
 */
function refuseLogin(email: string, meta: LoginMeta, reason: LoginRefusalReason, userId?: number): HttpError {
  // gate adversarial (ADV-O12-03): o campo e-mail é texto LIVRE — "joao@x.com MinhaSenha#2026" levava a senha ao log com o endereço
  // mascarado ao lado. Só um endereço ÚNICO (a regra da peça — D-EA26/D-EA27) vai mascarado; qualquer outro texto vai como '***'
  const addr = singleMailAddress(email)
  logger.warn('Login recusado (D-EA11)', {
    email: addr ? maskEmail(addr) : '***', ip: meta.ip ?? null, reason, at: new Date().toISOString(), ...(userId !== undefined ? { userId } : {}),
  })
  recordLoginRefusal(email)
  return new HttpError(401, LOGIN_REFUSED_MESSAGE)
}

export type LoginJudgementVerdict = 'blocked' | 'wrong' | 'right' | 'gone' | 'no-credential' | 'stale'
export interface LoginJudgement {
  verdict: LoginJudgementVerdict
  /** só no 'right': o `active` da linha TRAVADA (inativo = recusa sem gravar — D-EA6) */
  active?: string
  /**
   * só no 'right' (D-EA9/D-EA18): a senha certa está em formato/peso antigo E o hash novo foi pré-calculado fora da trava contra o MESMO
   * valor travado — o caller ADMITIDO regrava por compare-and-set (`rehashPassword`) na mesma transação. Ausente = nada a regravar (ou o
   * valor mudou entre a conferência e a trava: fica para o próximo login).
   */
  rehash?: { from: string; to: string }
  /** só no 'stale': o hash TRAVADO (≠ o conferido fora da trava) — o caller solta a trava e confere de novo contra ELE, fora dela */
  lockedHash?: string
  /** só no 'wrong': falhas na janela DEPOIS desta */
  failuresInWindow?: number
  /** só no 'wrong': esta falha levou a janela a 10 e a vaga do aviso ao dono foi tomada (D-EA15) — o e-mail sai depois do COMMIT */
  notice?: boolean
}

/**
 * O JULGAMENTO do login sob a trava da linha do usuário (passo 4 do protocolo, até a decisão): devolve o veredito; o caller faz o resto
 * (vínculos e token no caminho certo) NA MESMA transação. `preVerdict` = a senha conferida FORA da trava contra `user.password`.
 */
export async function judgeLoginAttempt(
  conn: PoolConnection, user: AuthUser, password: string, preVerdict: boolean | PasswordCheck, rehashTo?: string | null,
  opts: { staleIsRetry?: boolean } = {},
): Promise<LoginJudgement> {
  const locked = await lockUserCredential(conn, user.id)
  if (!locked) return { verdict: 'gone' }
  if (!locked.password) return { verdict: 'no-credential' }
  // (b) do parecer: o hash travado tem de ser o conferido. Mudou entre a conferência e a trava (troca de senha em paralelo — e, na Onda 4,
  // OUTRO login certo da mesma conta que acabou de regravar o MD5): com `staleIsRetry` (o login) devolve 'stale' SEM gravar nada — o
  // caller solta a trava e confere contra o hash novo FORA dela. Conhecimento negativo (prova H9, 2026-11-07): reconferir o scrypt SOB a
  // trava segurava a linha pelo tempo do hash mais a fila do pool do libuv — 3 logins certos simultâneos numa conta MD5 estouravam a espera
  // de 5 s dos outros (1205 = recusa da senha CERTA). Sem a opção (provas e testes antigos), reconfere aqui.
  const pre: PasswordCheck = typeof preVerdict === 'boolean' ? { ok: preVerdict, needsRehash: false, form: 'md5' } : preVerdict
  const same = locked.password === user.password
  if (!same && opts.staleIsRetry) return { verdict: 'stale', lockedHash: locked.password }
  const right = same ? pre.ok : (await checkStoredPassword('auth/login (reconferência sob a trava)', user.id, password, locked.password)).ok
  const before = await countLoginFailuresInWindow(user.id, conn)
  if (before >= LOGIN_MAX_FAILURES) return { verdict: 'blocked' }        // nada gravado, o veredito NÃO é olhado
  if (!right) {
    await insertLoginFailure(conn, user.id)
    const notice = before + 1 === LOGIN_MAX_FAILURES
      ? await claimNoticeSlot(conn, 'auth/login', user.id, LOGIN_BLOCK_NOTICE_PORT)
      : false
    return { verdict: 'wrong', failuresInWindow: before + 1, notice }
  }
  const rehash = same && pre.needsRehash && rehashTo ? { from: locked.password, to: rehashTo } : undefined
  return { verdict: 'right', active: locked.active, ...(rehash ? { rehash } : {}) }
}

/** Passo 1-3 do fluxo: autentica e decide pela quantidade de institutions. Toda recusa = a MESMA 401, depois do piso. */
export async function login(email: string, password: string, meta: LoginMeta = {}): Promise<LoginResult> {
  const started = performance.now()                    // monotônico: ajuste de relógio (NTP) no meio não distorce a espera
  try {
    return await loginOrRefuse(email, password, meta)
  } catch (err) {
    const rest = loginRefusalFloorMs - (performance.now() - started)
    if (rest > 0) await new Promise(r => setTimeout(r, rest))
    throw err
  }
}

type LoginTxOutcome =
  | { kind: 'judged'; judgement: LoginJudgement }
  | { kind: 'inactive' } | { kind: 'no-link' }
  | { kind: 'admitted'; result: LoginResult }
  | { kind: 'admitted-final'; token: string; payload: InstitutionPayload }

/** Teto do e-mail digitado (gate socrático, LOW: a porta pública levava até 2 MB ao banco e ao hash): acima dele, a mesma recusa de
 *  e-mail inexistente, sem tocar o banco — nenhum e-mail de login gravado passa disso (RFC 5321: 254 no caminho). */
export const LOGIN_EMAIL_MAX_LENGTH = 320

async function loginOrRefuse(email: string, password: string, meta: LoginMeta): Promise<LoginResult> {
  if (email.length > LOGIN_EMAIL_MAX_LENGTH) throw refuseLogin('', meta, 'inexistente')   // '' = nem o hash do alarme sobre o texto gigante
  const user = await findUserByEmail(email)
  if (!user) throw refuseLogin(email, meta, 'inexistente')
  if (!user.password) throw refuseLogin(email, meta, 'sem credencial', user.id)    // A-EA3: sem linha de falha

  // 2. pré-filtro SEM trava: a conta bloqueada nem confere a senha (o hash e a fila da trava não amplificam o ataque)
  let failures: number
  try {
    failures = await countLoginFailuresInWindow(user.id)
  } catch (err) {
    alarmNeutral('auth/login', user.id, err)
    throw refuseLogin(email, meta, 'falha interna', user.id)
  }
  if (failures >= LOGIN_MAX_FAILURES) throw refuseLogin(email, meta, 'bloqueado', user.id)

  // 3. a senha conferida FORA da trava (D-EA9: scrypt, centenas de ms — nunca segura a linha nem uma conexão do pool). Certa em formato ou
  // peso antigo (MD5 legado; scrypt de peso anterior — D-EA18): o hash NOVO também é calculado aqui, fora da trava; errada nunca recalcula.
  // 4. sob a trava. O hash travado ≠ o conferido = 'stale': nada gravado, a trava é solta e os passos 3–4 repetem contra o hash TRAVADO —
  // no máximo LOGIN_STALE_ROUNDS vezes; esgotado (o hash mudando sem parar), a recusa neutra de contenção, sem falha gravada.
  let current: AuthUser = user
  let outcome: LoginTxOutcome | undefined
  for (let round = 1; round <= LOGIN_STALE_ROUNDS && !outcome; round++) {
    outcome = await judgeRound(email, meta, current, password)
    if (outcome.kind === 'judged' && outcome.judgement.verdict === 'stale') {
      current = { ...current, password: outcome.judgement.lockedHash ?? null }
      outcome = undefined
    }
  }
  if (!outcome) throw refuseLogin(email, meta, 'contenção', user.id)
  return finishLogin(email, meta, user, outcome)
}

/** D-EA9: rodadas do login quando o hash muda entre a conferência e a trava (a 1ª + até 2 de novo). */
export const LOGIN_STALE_ROUNDS = 3

/** Passos 3–4 do protocolo numa rodada: conferência FORA da trava, julgamento SOB ela. */
async function judgeRound(email: string, meta: LoginMeta, user: AuthUser, password: string): Promise<LoginTxOutcome> {
  if (!user.password) throw refuseLogin(email, meta, 'sem credencial', user.id)
  // gate socrático da Onda 4 (MEDIUM): falha do scrypt (ENOMEM na alocação de 32 MiB, por ex.) só acontece para conta EXISTENTE com
  // credencial — 500 cru diria quem tem cadastro (D-EA6). Vira a MESMA recusa, com a linha da D-EA11, o contador da D-EA4 e alarme com ref
  let preVerdict: PasswordCheck
  let rehashTo: string | null
  try {
    preVerdict = await checkStoredPassword('auth/login', user.id, password, user.password)
    rehashTo = preVerdict.ok && preVerdict.needsRehash ? await hashPassword(password) : null
  } catch (err) {
    alarmNeutral('auth/login (hash da senha)', user.id, err)
    throw refuseLogin(email, meta, 'falha interna', user.id)
  }

  let outcome: LoginTxOutcome
  try {
    outcome = await withDeadlockRetry('auth/login', { userId: user.id }, 3, async () => {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const judgement = await judgeLoginAttempt(conn, user, password, preVerdict, rehashTo, { staleIsRetry: true })
        let out: LoginTxOutcome = { kind: 'judged', judgement }
        if (judgement.verdict === 'right') {
          if (judgement.active !== 'S') out = { kind: 'inactive' }
          else {
            // Gates das Ondas 1+2 (HIGH): sob a trava, NADA pede outra conexão ao pool — os vínculos vêm pela conexão da transação e
            // a assinatura não usa o banco; o bloco `context` (fato derivado, sem efeito de segurança) é lido DEPOIS do COMMIT
            const institutions = await getInstitutionsForUser(user.id, conn)
            // D-EA9/D-EA18: ADMITIDO com a senha em formato/peso antigo → regrava na MESMA transação, sob a trava, por compare-and-set,
            // SEM tocar password_set_at (a sessão aberta não cai — exceção nomeada da cerca D-EA7). Inativo/sem vínculo não regrava.
            if (institutions.length && judgement.rehash) {
              await rehashPassword(conn, user.id, judgement.rehash.from, judgement.rehash.to)
            }
            if (!institutions.length) out = { kind: 'no-link' }
            else if (institutions.length === 1) {
              // (d) do parecer: o token é ASSINADO com a trava segura (fecha a troca de senha entre a admissão e a assinatura)
              const signed = signFinalPayload(user.id, institutions[0])
              out = { kind: 'admitted-final', token: signed.token, payload: signed.payload }
            } else {
              out = { kind: 'admitted', result: { status: 'select', token: signSelectionToken(user.id), institutions } }
            }
          }
        }
        await conn.commit()
        return out
      } catch (err) {
        await conn.rollback().catch(() => undefined)
        throw err
      } finally {
        conn.release()
      }
    })
  } catch (err) {
    if (isLockWaitTimeout(err)) {
      // L7: contenção (1205) NUNCA vira 409 RESOURCE_BUSY — seria oráculo (a conta inexistente nunca espera)
      // D-EA11: UMA linha por recusa — o motivo 'contenção' já vai na linha da recusa (gate socrático: eram duas)
      throw refuseLogin(email, meta, 'contenção', user.id)
    }
    alarmNeutral('auth/login', user.id, err, { deadlockIsAlarm: true })   // deadlock que esgotou o retry também é alarme com ref (L7)
    throw refuseLogin(email, meta, (err as { code?: unknown })?.code === 'ER_LOCK_DEADLOCK' ? 'contenção' : 'falha interna', user.id)
  }
  return outcome
}

async function finishLogin(email: string, meta: LoginMeta, user: AuthUser, outcome: LoginTxOutcome): Promise<LoginResult> {
  if (outcome.kind === 'admitted') return outcome.result
  if (outcome.kind === 'admitted-final') {
    // o bloco `context` DEPOIS do COMMIT (conexão e trava já devolvidas). D-EA30 (Valdo 2026-11-05, "(a) Entra com padrão"): a admissão já
    // foi decidida sob a trava e o contexto é só ajuda de tela (decisão 17) — leitura que falha = contexto PADRÃO + alarme com ref; nunca
    // 500 (seria oráculo da senha certa: a errada responde 401)
    let context: SessionContext
    try {
      context = await getSessionContext(outcome.payload)
    } catch (err) {
      alarmNeutral('auth/login (contexto depois do COMMIT)', user.id, err, { deadlockIsAlarm: true })
      context = { isSalesman: false }
    }
    return { status: 'ok', token: outcome.token, context }
  }
  if (outcome.kind === 'inactive') throw refuseLogin(email, meta, 'inativo', user.id)
  if (outcome.kind === 'no-link') throw refuseLogin(email, meta, 'sem vínculo', user.id)
  const { judgement } = outcome
  if (judgement.verdict === 'wrong') {
    // D-EA3/D-EA15: a vaga foi tomada na transação (COMMIT feito) — o e-mail ao dono sai em SEGUNDO PLANO (a 401 não espera o SMTP)
    if (judgement.notice) runInBackground('auth/login', user.id, () => sendLoginBlockNotice(user))
    throw refuseLogin(email, meta, 'senha errada', user.id)
  }
  if (judgement.verdict === 'blocked') throw refuseLogin(email, meta, 'bloqueado', user.id)
  if (judgement.verdict === 'no-credential') throw refuseLogin(email, meta, 'sem credencial', user.id)
  throw refuseLogin(email, meta, 'inexistente', user.id)                       // 'gone': excluída entre a busca e a trava
}

/** Assunto do aviso de bloqueio do login (D-EA3) — distinto do aviso da recuperação (D-RS4); os testes separam os dois por ele. */
export const LOGIN_BLOCK_NOTICE_SUBJECT = 'Setes — tentativas de acesso à sua conta'

/**
 * D-EA3: o e-mail ao dono da conta BLOQUEADA no login — pelo e-mail de login GRAVADO, texto NEUTRO e único, sem link de ação, sem dizer
 * quantas tentativas: "registramos tentativas de acesso que não foram concluídas; se não foi você, troque a senha" (pela D-PV48 = o
 * titular pede código pela recuperação). Sai depois do COMMIT da vaga, em segundo plano; falha do SMTP = log (a vaga da hora fica
 * tomada — limite conhecido, como o da D-RS4). Em dev sem SMTP vai ao log.
 */
async function sendLoginBlockNotice(user: AuthUser): Promise<void> {
  const text = 'Registramos, há pouco, tentativas de acesso à sua conta do Setes ERP que não foram concluídas. '
    + 'Se não foi você, troque a sua senha pela opção "Esqueci minha senha" da tela de login. Não respondemos a este e-mail.'
  try {
    await sendMail({
      to: user.loginEmail,
      subject: LOGIN_BLOCK_NOTICE_SUBJECT,
      text,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#1B3A5F">Aviso de segurança</h2>
          <p>Registramos, há pouco, tentativas de acesso à sua conta do Setes ERP que não foram concluídas.</p>
          <p><strong>Se não foi você</strong>, troque a sua senha pela opção "Esqueci minha senha" da tela de login.</p>
          <p style="color:#8793B2;font-size:12px">Não respondemos a este e-mail.</p>
        </div>`,
    })
  } catch (err) {
    logger.error('Falha no envio do aviso de bloqueio do login (D-EA3)', { userId: user.id, ...mailErrorForLog(err) })   // D-EA21
    return
  }
  if (!isMailerConfigured() && !isProduction()) {
    logger.info('Aviso de bloqueio do login (D-EA3, modo dev, SMTP ausente)', { userId: user.id, email: maskEmail(user.loginEmail) })
  }
}

/** Boot (D-EA2/D-EA3): as duas tabelas do script 74 — sem elas o setes-api NÃO sobe. */
export async function assertLoginLockReady(): Promise<string> {
  await assertLoginLockSchema()
  return `ok (${LOGIN_MAX_FAILURES} erradas em ${LOGIN_FAILURE_WINDOW_MINUTES} min)`
}

// Passo 4: valida o token de seleção e o vínculo antes de emitir o JWT final
export async function selectInstitution(selectionToken: string, institutionId: number): Promise<IssuedSession> {
  let selection: { userId: number; iat: number }
  try {
    selection = verifySelectionToken(selectionToken)
  } catch {
    throw new HttpError(401, 'Token de seleção inválido ou expirado')
  }
  return issueForInstitution(selection.userId, institutionId, selection.iat)
}

// Passo 5: troca de institution com JWT final válido
export async function switchInstitution(userId: number, institutionId: number): Promise<IssuedSession> {
  return issueForInstitution(userId, institutionId)
}

// Nunca confia no body: revalida o vínculo no banco. D-EA7 (achado do guardião, 2026-10-31): a SELEÇÃO não passa pelo middleware — o token
// de seleção (5 min) emitido ANTES de uma troca de senha não pode cunhar o final depois dela: confere a MESMA sessão viva com o `iat` dele.
async function issueForInstitution(userId: number, institutionId: number, selectionIat?: number): Promise<IssuedSession> {
  const institutions = await getInstitutionsForUser(userId)
  const link = institutions.find(i => i.institutionId === institutionId)
  if (!link) throw new HttpError(403, 'Usuário sem vínculo ativo com esta institution')
  if (selectionIat !== undefined) {
    const who = { userId, institutionId: link.institutionId, schemaName: link.schemaName, role: link.profile ?? 'user' }
    if (!(await liveSession(who, selectionIat))) {
      throw new HttpError(401, 'O acesso deste usuário a este estabelecimento não vale mais — entre de novo', undefined,
        ErrorCodes.SESSION_REVOKED)
    }
  }
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
 * D-EA43 (Valdo 2026-11-07): 700 ms — a troca pelo código da conta existente calcula DOIS scrypt (em paralelo, ≈ o tempo de um: p99 496 ms
 * no dev, H8) e a inexistente nenhum; o pedido do código (mesmo piso, mesma peça) sobe junto. Revisto no servidor real (D-EA17/H11).
 */
export const PASSWORD_RESET_RESPONSE_FLOOR_MS = 700
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
function alarmNeutral(where: string, userId: number, err: unknown, opts: { deadlockIsAlarm?: boolean } = {}): void {
  // o login (L7): deadlock que chega aqui ESGOTOU o retry — vira alarme com ref, não aviso de contenção
  if (contentionToHttpError(err) && !(opts.deadlockIsAlarm && (err as { code?: unknown })?.code === 'ER_LOCK_DEADLOCK')) {
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
 * A PORTA da tabela de aviso de cada processo (parecer do guardião §P.3): a receita da vaga é UMA (abaixo); cada processo entrega a SUA
 * tabela — nunca um `kind` que misture processos (D-EA3/D-EA14: o bloqueio do login é outro processo que a recuperação).
 */
interface NoticeSlotPort {
  /** nome do SAVEPOINT (identificador simples) */
  savepoint: string
  hasRecent(conn: PoolConnection, userId: number): Promise<boolean>
  insert(conn: PoolConnection, userId: number): Promise<unknown>
}

/**
 * Toma a vaga do aviso ao dono da conta — no máximo UM por hora por conta — sob a trava do usuário, na MESMA transação que detectou o
 * gatilho (regras 12/13). Devolve true quando a vaga foi tomada (o e-mail sai depois do COMMIT, em segundo plano) e false quando a hora
 * já tem aviso ou o trecho foi desfeito.
 * Q-RS10/D-RS10 (gates socrático e adversarial, MEDIUM): o aviso é fato SECUNDÁRIO — a falha dele (GRANT sem INSERT na irmã, CHECK/coluna
 * divergente, banco) NUNCA pode desfazer o fato PRIMÁRIO da mesma transação (o +1 da tentativa errada; a 10ª falha do login): sem isto a
 * conta nunca bloquearia. SAVEPOINT em volta da vaga (a receita da `@shared/db/savepoint.runIsolated`, aqui com alarme COM REF em vez do
 * log cru — o erro do mysql2 leva o `sql`); falha = alarme (nunca silêncio) e a transação segue. 1213 desfaz a transação inteira: sobe.
 */
async function claimNoticeSlot(conn: PoolConnection, where: string, userId: number, port: NoticeSlotPort): Promise<boolean> {
  await conn.query(`SAVEPOINT ${port.savepoint}`)
  try {
    if (await port.hasRecent(conn, userId)) {
      await conn.query(`RELEASE SAVEPOINT ${port.savepoint}`)
      return false
    }
    await port.insert(conn, userId)
    await conn.query(`RELEASE SAVEPOINT ${port.savepoint}`)
    return true
  } catch (err) {
    const e = err as { code?: unknown } | null
    if (e?.code === 'ER_LOCK_DEADLOCK') throw err              // 1213 desfaz a transação inteira: cabe ao retry refazê-la toda
    await conn.query(`ROLLBACK TO SAVEPOINT ${port.savepoint}`)
    alarmNeutral(`${where} (aviso ao dono)`, userId, err)       // pane = ref na crashlytics; contenção = aviso — a vaga NÃO foi tomada
    return false
  }
}

/** D-EA3/D-EA14: a porta do aviso de BLOQUEIO do login (`tb_user_login_block_notice`, sql/74). */
const LOGIN_BLOCK_NOTICE_PORT: NoticeSlotPort = {
  savepoint: 'login_block_notice',
  hasRecent: hasRecentLoginBlockNotice,
  insert:    insertLoginBlockNotice,
}

/**
 * D-RS4: a vaga do aviso ao dono na recuperação (`tb_user_password_reset_notice`, sql/67) — causa forense `kind` E/C. Devolve a causa
 * quando a vaga foi tomada e `undefined` quando a hora já tem aviso. Tabela própria: não entra no teto de códigos.
 */
async function claimOwnerNotice(
  conn: PoolConnection, where: string, userId: number, kind: PasswordResetNoticeKind,
): Promise<PasswordResetNoticeKind | undefined> {
  const claimed = await claimNoticeSlot(conn, where, userId, {
    savepoint: 'owner_notice',
    hasRecent: hasRecentPasswordResetNotice,
    insert:    (c, id) => insertPasswordResetNotice(c, id, kind),
  })
  return claimed ? kind : undefined
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
  const locked = await lockUserCredential(conn, user.id)
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

/**
 * D-EA9 (Onda 4): o "nova senha igual à atual" pré-calculado FORA da trava (scrypt) contra o hash lido ANTES dela — vale sob a trava só se
 * o hash travado é o mesmo `checkedHash`.
 */
export interface SameAsCurrentPrecheck { checkedHash: string | null; same: boolean }

export type ConsumeVerdict = 'changed' | 'inactive' | 'none' | 'used' | 'expired' | 'exhausted' | 'wrong' | 'same-as-current'
export interface ConsumeOutcome {
  verdict: ConsumeVerdict
  /** D-RS4: esta tentativa errada ESGOTOU o código e a vaga do aviso ao dono foi tomada (kind 'E') — e-mail depois do COMMIT */
  notice?: PasswordResetNoticeKind
}

/**
 * Julga e CONTA a tentativa sob a trava da linha do usuário (rajadas paralelas não passam do teto): o código vigente certo troca a
 * senha e grava o uso na MESMA transação; o errado soma 1 (o esgotamento é derivado). Esgotado/vencido/usado não somam.
 * A tentativa errada que ESGOTA o código (a N-ésima) toma a vaga do aviso ao dono (D-RS4) — as seguintes (já esgotado) não.
 * D-EA5 (Onda 3 — §P.5 PP5): com `newPasswordPlain`, a senha IGUAL À ATUAL é recusada SÓ AQUI, DEPOIS do código certo e sob a trava —
 * antes do código seria ORÁCULO da senha atual sem prova de posse. Nessa recusa o código NÃO é gasto nem conta como erro.
 */
export async function judgePasswordResetCode(
  conn: PoolConnection, user: AuthUser, code: string, newPasswordHash: string, newPasswordPlain?: string,
  preSame?: SameAsCurrentPrecheck,
): Promise<ConsumeOutcome> {
  const locked = await lockUserCredential(conn, user.id)
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
  if (newPasswordPlain !== undefined) {
    // D-EA9: o "igual à atual" foi conferido FORA da trava contra o hash lido antes dela. Mudou entre a leitura e a trava = reconfere contra
    // o travado — caminho na prática INALCANÇÁVEL na rota: o HMAC do código é amarrado ao hash TRAVADO (acima), então hash trocado = código
    // 'wrong' antes de chegar aqui; fica só para quem chama a peça sem o pré-cálculo (provas e testes)
    const same = preSame && preSame.checkedHash === locked.password
      ? preSame.same
      : (await checkPassword(newPasswordPlain, locked.password)).ok
    if (same) return { verdict: 'same-as-current' }
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
  await sendRecoveryMail(user.loginEmail, code, user.id)
}

async function sendRecoveryMail(email: string, code: string, userId: number): Promise<void> {
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
    // D-EA21: e-mail mascarado e o erro do SMTP sem o endereço cru (o nodemailer o põe na mensagem e em `response`/`rejected`)
    logger.error('Falha no envio do email de recuperação', { userId, email: maskEmail(email), ...mailErrorForLog(err) })
    // segue: o código está gravado; em dev sai no log abaixo
  }

  // Modo DEV (D-RS5): sem SMTP — ou com o SMTP do dev falhando (gate adversarial, LOW) — o código vai ao LOG, senão iria a lugar
  // nenhum e ainda consumiria o teto. Em PRODUÇÃO o boot já recusou subir sem SMTP (`assertMailerReady`); este cinto garante que,
  // aconteça o que acontecer com o ambiente em execução, o código NUNCA vai ao log de produção (falha do SMTP real = só o erro acima).
  if (!delivered && !isProduction()) {
    // D-EA21: e-mail mascarado; o `userId` identifica a conta (com o e-mail mascarado, duas contas `v***@x` seriam indistinguíveis)
    logger.info('Código de recuperação de senha (modo dev, SMTP ausente ou com falha)', { userId, email: maskEmail(email), code })
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
    logger.error('Falha no envio do aviso ao dono da conta (D-RS4)', { userId: user.id, kind, ...mailErrorForLog(err) })   // D-EA21
    return
  }
  if (!isMailerConfigured() && !isProduction()) {
    logger.info('Aviso ao dono da conta (D-RS4, modo dev, SMTP ausente)', { userId: user.id, kind, email: maskEmail(user.loginEmail) })   // D-EA21
  }
}

// Passo 2: valida email + código e troca a senha (o veredito do judgePasswordResetCode; toda recusa = a MESMA 401).
// A validação do payload vem ANTES de tocar o código (senão o 400 diria "código certo"). Falha do banco depois de achar a
// conta também sai como a recusa neutra (com o erro no log) — a contenção não pode virar oráculo de existência.
// O hash (scrypt — D-EA9) aplicado AQUI no backend — o app envia texto puro por HTTPS.
export async function changePassword(email: string, code: string, newPassword: string): Promise<void> {
  // D-EA5/D-EA16: a política que NÃO depende da conta (tamanho, lista de comuns, parte local do e-mail DIGITADO) vem ANTES do código —
  // julga só o texto da requisição, então não diz nada sobre a conta (400, como era o mínimo 5). A "igual à atual" fica no julgamento.
  const problem = passwordProblems(newPassword, email)[0]
  if (problem) {
    throw new HttpError(400, PASSWORD_PROBLEM_MESSAGES[problem], [{ field: 'newPassword', message: PASSWORD_PROBLEM_MESSAGES[problem] }],
      ErrorCodes.VALIDATION_FAILED)
  }
  return withResponseFloor(() => changePasswordByCode(email, code, newPassword))
}

async function changePasswordByCode(email: string, code: string, newPassword: string): Promise<void> {
  const user = await findUserByEmail(email)
  if (!user || user.active !== 'S') throw new HttpError(401, INVALID_PASSWORD_RESET_CODE)

  // D-EA9: os DOIS scrypt (o hash da nova e o "igual à atual") FORA da trava e em paralelo — custo de 2 cálculos por tentativa da conta
  // existente, contido pelo limite por e-mail e por IP da rota (registrado no gate da Onda 4)
  let newHash: string, sameNow: PasswordCheck
  try {
    ;[newHash, sameNow] = await Promise.all([
      hashPassword(newPassword),
      checkPassword(newPassword, user.password),   // sem alarme aqui: forma inválida = 'não é igual'; o LOGIN da conta alarma
    ])
  } catch (err) {
    // gate socrático da Onda 4 (MEDIUM): falha do scrypt só na conta existente — a MESMA 401 neutra, com alarme (nunca 500)
    alarmNeutral('auth/change-password (hash da senha)', user.id, err)
    throw new HttpError(401, INVALID_PASSWORD_RESET_CODE)
  }
  const preSame: SameAsCurrentPrecheck = { checkedHash: user.password, same: sameNow.ok }
  let outcome: ConsumeOutcome
  try {
    outcome = await inPasswordResetTx('auth/change-password', user.id,
      conn => judgePasswordResetCode(conn, user, code, newHash, newPassword, preSame))
  } catch (err) {
    alarmNeutral('auth/change-password', user.id, err)
    throw new HttpError(401, INVALID_PASSWORD_RESET_CODE)
  }
  if (outcome.verdict === 'changed') return
  if (outcome.verdict === 'same-as-current') {
    // D-EA37 (Valdo, "(a) Registrar no log"): a recusa não gasta o código nem conta erro (PP5), mas quem tem o código pode testar
    // palpites da senha atual — cada recusa deixa UMA linha forense (conta + e-mail mascarado; nunca a senha nem o código)
    logger.warn('Troca de senha recusada: nova senha igual à atual (D-EA37)', { userId: user.id, email: maskEmail(user.loginEmail) })
    const message = PASSWORD_PROBLEM_MESSAGES['same-as-current']
    throw new HttpError(422, message, [{ field: 'newPassword', message }], ErrorCodes.PASSWORD_SAME_AS_CURRENT)
  }
  // forense: o motivo interno vai ao log (nunca o código); a resposta é uma só
  if (outcome.verdict === 'wrong' || outcome.verdict === 'exhausted') {
    logger.warn('Troca de senha por código recusada', { userId: user.id, verdict: outcome.verdict, ownerNotice: outcome.notice })
  }
  // D-RS4: esta errada ESGOTOU o código e a vaga do aviso foi tomada (COMMIT feito) — o e-mail ao dono sai em SEGUNDO PLANO: a
  // resposta (a mesma 401, dentro do piso) não espera o SMTP, senão o tempo diria que a conta existe
  if (outcome.notice) runInBackground('auth/change-password', user.id, () => sendOwnerNotice(user, outcome.notice!))
  throw new HttpError(401, INVALID_PASSWORD_RESET_CODE)
}
