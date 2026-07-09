import pool from '@shared/db/connection'

export interface AuthUser {
  id:       number
  password: string | null
  active:   string
}

export interface UserInstitution {
  institutionId: number
  schemaName:    string
  name:          string
  profile:       string | null
}

// Autenticação: email do grupo 2 = "sistema" (Fase 2, seção Workflow)
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT u.id, u.password, u.active
     FROM setes_central.tb_user u
       INNER JOIN setes_central.tb_entity_has_mailing ehm ON (ehm.tb_entity_id = u.id)
       INNER JOIN setes_central.tb_mailing m ON (m.id = ehm.tb_mailing_id)
     WHERE m.email = ?
       AND ehm.tb_mailing_group_id = 2
       AND ehm.deleted = 'N' AND m.deleted = 'N' AND u.deleted = 'N'
     LIMIT 1`,
    [email]
  )
  if (!rows.length) return null
  return { id: Number(rows[0].id), password: rows[0].password, active: rows[0].active }
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
// Recuperação/alteração de senha (fluxo do weberpsetes):
// código em tb_user.activation_key + janela de validade via updated_at
// ---------------------------------------------------------------------

export async function setActivationKey(userId: number, code: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_user SET activation_key = ?, updated_at = NOW() WHERE id = ?`,
    [code, userId]
  )
}

export interface ActivationInfo {
  activationKey: string | null
  ageMinutes:    number
}

export async function getActivationInfo(userId: number): Promise<ActivationInfo | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT activation_key AS activationKey,
            TIMESTAMPDIFF(MINUTE, updated_at, NOW()) AS ageMinutes
     FROM setes_central.tb_user WHERE id = ? AND deleted = 'N'`,
    [userId]
  )
  if (!rows.length) return null
  return { activationKey: rows[0].activationKey, ageMinutes: Number(rows[0].ageMinutes ?? 0) }
}

// Senha já chega com hash aplicado pelo service (decisão 2 — nunca na query)
export async function updatePassword(userId: number, passwordHash: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_user
     SET password = ?, activation_key = NULL, updated_at = NOW()
     WHERE id = ?`,
    [passwordHash, userId]
  )
}
