import pool from '@shared/db/connection'

export async function getInstitutionInfo(schemaName: string) {
  const conn = await pool.getConnection()
  try {
    const [rows] = await conn.query<any[]>(
      `SELECT i.id, e.nick_trade AS name, e.name_company AS companyName, i.active
       FROM setes_central.tb_institution i
       INNER JOIN setes_central.tb_entity e ON (e.id = i.id)
       WHERE i.schema_name = ? AND i.deleted = 'N'`,
      [schemaName]
    )
    return rows[0] ?? null
  } finally {
    conn.release()
  }
}

// Nome de exibição do usuário logado (tb_user herda PK de tb_entity — decisão 1 Fase 2)
export async function getUserName(userId: number): Promise<string | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT e.nick_trade AS nickTrade, e.name_company AS nameCompany
     FROM setes_central.tb_entity e
     WHERE e.id = ? AND e.deleted = 'N'`,
    [userId]
  )
  if (!rows.length) return null
  return rows[0].nickTrade || rows[0].nameCompany || null
}

// ---------------------------------------------------------------------
// Preferências do usuário — setes_central.tb_user_has_preference
// (setes-app Fase 1, decisão 14)
// ---------------------------------------------------------------------

export async function getPreferences(userId: number): Promise<Record<string, string>> {
  const [rows] = await pool.query<any[]>(
    `SELECT preference_key AS prefKey, preference_value AS prefValue
     FROM setes_central.tb_user_has_preference
     WHERE tb_user_id = ? AND deleted = 'N'`,
    [userId]
  )
  const prefs: Record<string, string> = {}
  for (const row of rows) prefs[row.prefKey] = row.prefValue
  return prefs
}

export async function upsertPreference(userId: number, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO setes_central.tb_user_has_preference
       (tb_user_id, preference_key, preference_value, created_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       preference_value = VALUES(preference_value),
       updated_at = NOW(),
       deleted = 'N'`,
    [userId, key, value]
  )
}

// ---------------------------------------------------------------------
// Tema por institution — setes_central.tb_institution_theme
// (setes-app Fase 1, decisão 16 — herança por PK: id = tb_institution.id)
// ---------------------------------------------------------------------

export interface ThemeRow {
  primaryColor:   string | null
  secondaryColor: string | null
  logoPath:       string | null
}

export async function getTheme(institutionId: number): Promise<ThemeRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT primary_color AS primaryColor, secondary_color AS secondaryColor, logo_path AS logoPath
     FROM setes_central.tb_institution_theme
     WHERE id = ? AND deleted = 'N'`,
    [institutionId]
  )
  return rows[0] ?? null
}

export async function upsertTheme(
  institutionId: number,
  theme: { primaryColor?: string | null; secondaryColor?: string | null; logoPath?: string | null }
): Promise<void> {
  await pool.query(
    `INSERT INTO setes_central.tb_institution_theme
       (id, primary_color, secondary_color, logo_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       primary_color   = COALESCE(VALUES(primary_color),   primary_color),
       secondary_color = COALESCE(VALUES(secondary_color), secondary_color),
       logo_path       = COALESCE(VALUES(logo_path),       logo_path),
       updated_at = NOW(),
       deleted = 'N'`,
    [institutionId, theme.primaryColor ?? null, theme.secondaryColor ?? null, theme.logoPath ?? null]
  )
}

// ---------------------------------------------------------------------
// Menus dinâmicos (setes-app Fase 1, decisões 18 e 21)
// Config do institution vive no setes_<schema>; catálogo na central.
// schemaName vem do JWT assinado — ainda assim validado (defesa em profundidade).
// ---------------------------------------------------------------------

const SCHEMA_RE = /^setes_[a-z0-9_]+$/

function assertSchema(schemaName: string): string {
  if (!SCHEMA_RE.test(schemaName)) throw new Error(`schemaName inválido: ${schemaName}`)
  return schemaName
}

export interface MenuInterfaceRow {
  moduleId:             number | null
  moduleDescription:    string | null
  moduleIcon:           number | null
  interfaceId:          number
  interfaceDescription: string | null
  i18nKey:              string | null  // decisão 26: chave de tradução; app faz fallback para description
  buttonAction:         string | null
  imgIndex:             number | null
}

// Interfaces registradas em módulos do cliente (workflow do prompt, passo 1)
export async function getModuleInterfaces(
  schemaName: string, userId: number, skipPrivilegeFilter: boolean
): Promise<MenuInterfaceRow[]> {
  const s = assertSchema(schemaName)
  const privilegeFilter = skipPrivilegeFilter ? '' : `
    AND EXISTS (SELECT 1 FROM \`${s}\`.tb_user_has_privilege uhp
                WHERE uhp.tb_user_id = ? AND uhp.tb_interface_id = i.id
                  AND uhp.active = 'S' AND uhp.deleted = 'N')`
  const params = skipPrivilegeFilter ? [] : [userId]

  const [rows] = await pool.query<any[]>(
    `SELECT m.id            AS moduleId,
            m.description   AS moduleDescription,
            m.image_icon    AS moduleIcon,
            i.id            AS interfaceId,
            i.description   AS interfaceDescription,
            i.i18n_key      AS i18nKey
     FROM \`${s}\`.tb_module m
     INNER JOIN \`${s}\`.tb_module_has_interface mhi
       ON (mhi.tb_module_id = m.id AND mhi.active = 'S' AND mhi.deleted = 'N')
     INNER JOIN \`${s}\`.tb_institution_has_interface ihi
       ON (ihi.tb_interface_id = mhi.tb_interface_id AND ihi.active = 'S' AND ihi.deleted = 'N')
     INNER JOIN setes_central.tb_interface i
       ON (i.id = mhi.tb_interface_id AND i.deleted = 'N')
     WHERE m.deleted = 'N'${privilegeFilter}
     ORDER BY m.description, i.description`,
    params
  )
  return rows
}

// UNION conceitual: interfaces contratadas ainda sem módulo,
// agrupadas por tb_interface.group_default (workflow do prompt, passo 2)
export async function getUngroupedInterfaces(
  schemaName: string, userId: number, skipPrivilegeFilter: boolean
): Promise<MenuInterfaceRow[]> {
  const s = assertSchema(schemaName)
  const privilegeFilter = skipPrivilegeFilter ? '' : `
    AND EXISTS (SELECT 1 FROM \`${s}\`.tb_user_has_privilege uhp
                WHERE uhp.tb_user_id = ? AND uhp.tb_interface_id = i.id
                  AND uhp.active = 'S' AND uhp.deleted = 'N')`
  const params = skipPrivilegeFilter ? [] : [userId]

  const [rows] = await pool.query<any[]>(
    `SELECT NULL            AS moduleId,
            i.group_default AS moduleDescription,
            NULL            AS moduleIcon,
            i.id            AS interfaceId,
            i.description   AS interfaceDescription,
            i.i18n_key      AS i18nKey
     FROM \`${s}\`.tb_institution_has_interface ihi
     INNER JOIN setes_central.tb_interface i
       ON (i.id = ihi.tb_interface_id AND i.deleted = 'N')
     WHERE ihi.active = 'S' AND ihi.deleted = 'N'
       AND NOT EXISTS (SELECT 1 FROM \`${s}\`.tb_module_has_interface mhi
                       WHERE mhi.tb_interface_id = i.id
                         AND mhi.active = 'S' AND mhi.deleted = 'N')${privilegeFilter}
     ORDER BY i.group_default, i.description`,
    params
  )
  return rows
}

export interface PrivilegeRow {
  interfaceId: number
  privilegeId: number
  description: string | null
}

// Privilégios do usuário por interface (decisão 21 — alimenta os botões da UI)
export async function getUserPrivileges(schemaName: string, userId: number): Promise<PrivilegeRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT uhp.tb_interface_id AS interfaceId,
            p.id                AS privilegeId,
            p.description       AS description
     FROM \`${s}\`.tb_user_has_privilege uhp
     INNER JOIN setes_central.tb_privilege p ON (p.id = uhp.tb_privilege_id AND p.deleted = 'N')
     WHERE uhp.tb_user_id = ? AND uhp.active = 'S' AND uhp.deleted = 'N'`,
    [userId]
  )
  return rows
}

// Superusuário: todos os privilégios do catálogo por interface (bypass — decisão 14 Fase 2)
export async function getAllInterfacePrivileges(): Promise<PrivilegeRow[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT ihp.tb_interface_id AS interfaceId,
            p.id                AS privilegeId,
            p.description       AS description
     FROM setes_central.tb_interface_has_privilege ihp
     INNER JOIN setes_central.tb_privilege p ON (p.id = ihp.tb_privilege_id AND p.deleted = 'N')
     WHERE ihp.active = 'S' AND ihp.deleted = 'N'`
  )
  return rows
}
