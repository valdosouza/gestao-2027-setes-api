import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { isLockWaitSupported } from '@shared/db/counters'

export interface AuthUser {
  id:       number
  password: string | null
  active:   string
  /** o e-mail de login COMO GRAVADO (a busca casa pela colação _ci) — entra no HMAC do código de troca de senha */
  loginEmail: string
}

export interface UserInstitution {
  institutionId: number
  schemaName:    string
  name:          string
  profile:       string | null
}

// Autenticação: email do grupo 2 = "sistema" (Fase 2, seção Workflow). ORDER BY: e-mail repetido (dado anômalo) resolve
// SEMPRE a mesma conta — o pedido de troca de senha emitido para uma é consumido pela mesma (Q-PV38).
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT u.id, u.password, u.active, m.email AS loginEmail
     FROM setes_central.tb_user u
       INNER JOIN setes_central.tb_entity_has_mailing ehm ON (ehm.tb_entity_id = u.id)
       INNER JOIN setes_central.tb_mailing m ON (m.id = ehm.tb_mailing_id)
     WHERE m.email = ?
       AND ehm.tb_mailing_group_id = 2
       AND ehm.deleted = 'N' AND m.deleted = 'N' AND u.deleted = 'N'
     ORDER BY u.id, m.id
     LIMIT 1`,
    [email]
  )
  if (!rows.length) return null
  return { id: Number(rows[0].id), password: rows[0].password, active: rows[0].active, loginEmail: String(rows[0].loginEmail ?? '') }
}

// Institutions ativas do usuário (Passo 2 do fluxo de login)
export async function getInstitutionsForUser(userId: number): Promise<UserInstitution[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT i.id AS institutionId, i.schema_name AS schemaName, e.nick_trade AS name, ihu.kind AS profile
     FROM setes_central.tb_institution_has_user ihu
       INNER JOIN setes_central.tb_institution i ON (i.id = ihu.tb_institution_id)
       INNER JOIN setes_central.tb_entity e      ON (e.id = i.id)
     WHERE ihu.tb_user_id = ?
       AND ihu.active = 'S' AND ihu.deleted = 'N'
       AND i.active   = 'S' AND i.deleted   = 'N'`,
    [userId]
  )
  return rows.map(r => ({
    institutionId: Number(r.institutionId),
    schemaName:    r.schemaName,
    name:          r.name,
    profile:       r.profile,
  }))
}
// ---------------------------------------------------------------------
// Recuperação/alteração de senha — o PEDIDO DE TROCA DE SENHA (Q-PV38/D-PV13, 2026-10-18; sql/67 + parecer
// do guardião): uma linha de setes_central.tb_user_password_reset por código emitido. O único fato gravado
// depois da emissão é o USO (`used_at`); vale só o código de MAIOR `seq` do usuário, não usado, dentro do
// prazo e abaixo do teto de tentativas erradas (tudo derivado). O código nunca é guardado — só o HMAC (o
// service o calcula). Substitui a maquete tb_user.activation_key + tb_user.updated_at.
// Protocolo de trava (PADROES §9 regras 12 e 13 — provado em schema descartável por scripts/prove-password-reset-lock.ts):
// o SERIALIZADOR é a linha do usuário em tb_user (ela EXISTE — trava de REGISTRO), tomada como 1º statement de toda
// transação do pedido, ANTES de qualquer leitura consistente. Por isso as leituras das linhas DELE em
// tb_user_password_reset são CONSISTENTES, sem FOR UPDATE: o retrato do InnoDB nasce na 1ª leitura consistente — depois
// da espera pela trava — e já vê tudo o que o dono anterior confirmou; e só quem segura essa trava escreve nas linhas
// dele. Travar a FAIXA do filho (`… WHERE tb_user_id = ? FOR UPDATE`) poria trava de INTERVALO na fronteira com o
// usuário VIZINHO, e o INSERT do vizinho fecharia ciclo — 1ª prova: 12 contas emitindo juntas, 1 deadlock passou de 5
// retentativas. As gravações são pela PK (UPDATE de linha existente / INSERT): nenhuma trava de intervalo no filho.
// O `seq` é MAX+1 POR USUÁRIO, nunca global.
// ---------------------------------------------------------------------

export interface LockedUser {
  id:       number
  active:   string
  /** hash atual da senha (entra no HMAC do código — trocar a senha invalida o código aberto) */
  password: string | null
}

/** Espera máxima pela trava da linha do usuário: a rota é PÚBLICA — quem espera mais recebe 1205 (resposta neutra), nunca prende o pool. */
export const PASSWORD_RESET_LOCK_WAIT_SECONDS = 5

/** 1º lock de toda transação do pedido de troca de senha: a linha do usuário (null = excluído). Espera limitada (D-A23 — `WAIT n`). */
export async function lockUserForPasswordReset(conn: PoolConnection, userId: number): Promise<LockedUser | null> {
  const wait = isLockWaitSupported() ? ` WAIT ${PASSWORD_RESET_LOCK_WAIT_SECONDS}` : ''
  const [rows] = await conn.query<any[]>(
    `SELECT id, active, password FROM setes_central.tb_user WHERE id = ? AND deleted = 'N' FOR UPDATE${wait}`,
    [userId]
  )
  return rows.length ? { id: Number(rows[0].id), active: String(rows[0].active), password: rows[0].password ?? null } : null
}

export interface PasswordResetIssueCount {
  lastHour: number
  lastDay:  number
}

/**
 * Quantos códigos o usuário recebeu na última hora e nas últimas 24 h. Leitura que DECIDE, protegida pela trava da linha do
 * usuário (protocolo acima — consistente, sem FOR UPDATE). Conta TODA linha, inclusive uma soft-deletada: o teto é de
 * EMISSÕES, e emissão é fato que aconteceu.
 */
export async function countPasswordResetsIssued(conn: PoolConnection, userId: number): Promise<PasswordResetIssueCount> {
  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(SUM(created_at > NOW() - INTERVAL 1 HOUR), 0) AS lastHour,
            COUNT(*) AS lastDay
       FROM setes_central.tb_user_password_reset
      WHERE tb_user_id = ? AND created_at > NOW() - INTERVAL 24 HOUR`,
    [userId]
  )
  return { lastHour: Number(rows[0]?.lastHour ?? 0), lastDay: Number(rows[0]?.lastDay ?? 0) }
}

/** O próximo `seq` do usuário (MAX+1 sob a trava da linha dele em tb_user — leitura consistente, protocolo acima). */
export async function nextPasswordResetSeq(conn: PoolConnection, userId: number): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM setes_central.tb_user_password_reset WHERE tb_user_id = ?`,
    [userId]
  )
  return Number(rows[0]?.nextSeq ?? 1)
}

export async function insertPasswordReset(conn: PoolConnection, userId: number, seq: number, codeHmac: string): Promise<void> {
  await conn.query(
    `INSERT INTO setes_central.tb_user_password_reset
       (tb_user_id, seq, code_hmac, failed_attempts, used_at, created_at, updated_at, deleted)
     VALUES (?, ?, ?, 0, NULL, NOW(), NOW(), 'N')`,
    [userId, seq, codeHmac]
  )
}

export interface CurrentPasswordReset {
  seq:            number
  codeHmac:       string
  failedAttempts: number
  /** used_at IS NULL e não soft-deletada */
  open:           boolean
  /** created_at dentro do prazo (julgado pelo relógio do banco, em UTC) */
  fresh:          boolean
}

/**
 * O código VIGENTE do usuário = o de MAIOR `seq` (pedir outro substitui o anterior por construção), lido sob a trava da linha
 * do usuário (protocolo acima). NÃO filtra `deleted`/`used_at`: excluir ou usar o mais novo nunca ressuscita um mais velho —
 * vira `open = false`.
 */
export async function readCurrentPasswordReset(
  conn: PoolConnection, userId: number, ttlMinutes: number,
): Promise<CurrentPasswordReset | null> {
  const [rows] = await conn.query<any[]>(
    `SELECT seq, code_hmac AS codeHmac, failed_attempts AS failedAttempts,
            (used_at IS NULL AND deleted = 'N') AS isOpen,
            (created_at > NOW() - INTERVAL ? MINUTE) AS isFresh
       FROM setes_central.tb_user_password_reset
      WHERE tb_user_id = ?
      ORDER BY seq DESC LIMIT 1`,
    [ttlMinutes, userId]
  )
  if (!rows.length) return null
  return {
    seq:            Number(rows[0].seq),
    codeHmac:       String(rows[0].codeHmac),
    failedAttempts: Number(rows[0].failedAttempts ?? 0),
    open:           Number(rows[0].isOpen) === 1,
    fresh:          Number(rows[0].isFresh) === 1,
  }
}

/** Conta uma tentativa ERRADA contra o código vigente (o esgotamento é derivado de failed_attempts ≥ teto). */
export async function recordFailedPasswordResetAttempt(conn: PoolConnection, userId: number, seq: number): Promise<void> {
  await conn.query(
    `UPDATE setes_central.tb_user_password_reset
        SET failed_attempts = failed_attempts + 1, updated_at = NOW()
      WHERE tb_user_id = ? AND seq = ?`,
    [userId, seq]
  )
}

/** O único fato depois da emissão: o USO (write-once — `used_at IS NULL` na própria gravação). */
export async function markPasswordResetUsed(conn: PoolConnection, userId: number, seq: number): Promise<void> {
  await conn.query(
    `UPDATE setes_central.tb_user_password_reset
        SET used_at = NOW(), updated_at = NOW()
      WHERE tb_user_id = ? AND seq = ? AND used_at IS NULL`,
    [userId, seq]
  )
}

// ---------------------------------------------------------------------
// D-RS4 (Valdo, 2026-10-20; parecer do guardião 2026-10-21): o AVISO AO DONO DA CONTA — setes_central.tb_user_password_reset_notice,
// IRMÃ do pedido sob tb_user (fato da CONTA, não do código: no caso do teto não existe código). Mesmo protocolo de trava (acima): a
// vaga da hora é lida e tomada (EXISTS + INSERT pela PK, seq MAX+1 por usuário) sob a trava da linha do usuário, na MESMA transação
// que detectou o gatilho; o e-mail sai depois do COMMIT. `kind` = a CAUSA, forense: 'E' código esgotado por erradas | 'C' teto.
// ---------------------------------------------------------------------

export type PasswordResetNoticeKind = 'E' | 'C'

/** Janela da coalescência: no máximo UM aviso por conta por hora (D-RS4). */
export const PASSWORD_RESET_NOTICE_WINDOW_MINUTES = 60

/** Já existe aviso ao dono desta conta dentro da janela? Leitura consistente depois da trava do usuário (protocolo acima). */
export async function hasRecentPasswordResetNotice(conn: PoolConnection, userId: number, windowMinutes = PASSWORD_RESET_NOTICE_WINDOW_MINUTES): Promise<boolean> {
  const [rows] = await conn.query<any[]>(
    `SELECT EXISTS(SELECT 1 FROM setes_central.tb_user_password_reset_notice
                    WHERE tb_user_id = ? AND created_at > NOW() - INTERVAL ? MINUTE) AS recent`,
    [userId, windowMinutes]
  )
  return Number(rows[0]?.recent ?? 0) === 1
}

/** Toma a vaga da hora: INSERT pela PK com seq = MAX+1 POR USUÁRIO (sob a trava do usuário — nunca MAX+1 global). */
export async function insertPasswordResetNotice(conn: PoolConnection, userId: number, kind: PasswordResetNoticeKind): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM setes_central.tb_user_password_reset_notice WHERE tb_user_id = ?`,
    [userId]
  )
  const seq = Number(rows[0]?.nextSeq ?? 1)
  await conn.query(
    `INSERT INTO setes_central.tb_user_password_reset_notice (tb_user_id, seq, kind, created_at, updated_at, deleted)
     VALUES (?, ?, ?, NOW(), NOW(), 'N')`,
    [userId, seq, kind]
  )
  return seq
}

// Senha já chega com hash aplicado pelo service (decisão 2 — nunca na query). O código vive no pedido de troca de senha (marcado
// como usado na MESMA transação); `activation_key` segue LIMPA aqui como antes — nenhum leitor a aceita mais, e um código antigo
// em texto puro não pode voltar a valer num rollback para o código anterior (que lia activation_key + updated_at).
export async function updatePassword(conn: PoolConnection, userId: number, passwordHash: string): Promise<void> {
  await conn.query(
    `UPDATE setes_central.tb_user SET password = ?, activation_key = NULL, updated_at = NOW() WHERE id = ?`,
    [passwordHash, userId]
  )
}

/**
 * Boot (molde do D-IB36): sem a tabela do pedido de troca de senha o setes-api NÃO sobe — senão a recuperação de
 * senha viraria 500 na 1ª chamada. Aplique sql/67 em setes_central ANTES do deploy.
 */
export async function assertPasswordResetSchema(): Promise<string> {
  // as DUAS tabelas do script 67: o pedido (Q-PV38) e o aviso ao dono (D-RS4)
  for (const [table, columns, ref] of [
    ['tb_user_password_reset', 'tb_user_id, seq, code_hmac, failed_attempts, used_at, created_at, deleted', 'Q-PV38'],
    ['tb_user_password_reset_notice', 'tb_user_id, seq, kind, created_at, deleted', 'D-RS4'],
  ] as const) {
    try {
      await pool.query(`SELECT ${columns} FROM setes_central.${table} LIMIT 0`)
    } catch (err: any) {
      if (err?.errno === 1146 || err?.code === 'ER_NO_SUCH_TABLE' || err?.errno === 1054 || err?.code === 'ER_BAD_FIELD_ERROR') {
        throw new Error(`setes_central.${table} ausente ou incompleta — aplique o script sql/67_user_password_reset_ddl.sql `
          + `em setes_central ANTES do setes-api (${ref})`)
      }
      throw err
    }
  }
  return 'ok'
}
