import pool from '@shared/db/connection'

// =====================================================================
// Types
// =====================================================================

export interface CountryRow {
  id:   number
  name: string | null
}

export interface StateRow {
  id:           number
  tbCountryId:  number
  abbreviation: string | null
  name:         string | null
  aliquota:     number | null
  /** Nome do país (JOIN em tb_country) — exibição no lookup do app. */
  countryName:  string | null
}

export interface CityRow {
  id:         number
  tbStateId:  number
  ibge:       string | null
  name:       string | null
  aliqIss:    number
  population: number
  density:    number
  area:       number
  /** Nome do estado (JOIN em tb_state) — exibição no lookup do app. */
  stateName:  string | null
}

export interface StateInput {
  tbCountryId:  number
  abbreviation: string
  name:         string
  aliquota?:    number | null
}

export interface CityInput {
  tbStateId:   number
  ibge?:       string | null
  name:        string
  aliqIss?:    number
  population?: number
  density?:    number
  area?:       number
}

export interface CityCreateInput extends CityInput {
  id: number  // Código IBGE do município, informado pelo usuário na inclusão
}

export interface InterfaceRow {
  id:           number
  groupDefault: string | null
  i18nKey:      string | null
  description:  string | null
  kind:         string | null
  position:     string | null
  /** Privilégios vinculados (tb_interface_has_privilege com deleted='N' e active='S'). */
  privilegeIds: number[]
}

export interface InterfaceInput {
  groupDefault?: string | null
  i18nKey?:      string | null
  description:   string
  kind?:         string | null
  position?:     string | null
}

export interface PrivilegeRow {
  id:          number
  description: string | null
}

// =====================================================================
// Country
// =====================================================================

export async function listCountries(filter: string): Promise<CountryRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, name
     FROM setes_central.tb_country
     WHERE deleted = 'N'
       AND (? IS NULL OR name LIKE ?)
     ORDER BY name
     LIMIT 200`,
    [like, like]
  )
  return rows
}

export async function getCountry(id: number): Promise<CountryRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT id, name FROM setes_central.tb_country WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Verifica se já existe país com o id — INCLUINDO registros com deleted='S'.
 * O código de país é padrão mundial (BACEN, ex.: Brasil 1058) e nunca é
 * reaproveitado, mesmo após exclusão lógica (decisão do Valdo, 2026-07-10).
 */
export async function countryIdExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_country WHERE id = ?`,
    [id]
  )
  return rows.length > 0
}

/**
 * Insere país com o id INFORMADO (código BACEN) — não há geração sequencial
 * para tb_country (decisão do Valdo, 2026-07-10).
 */
export async function insertCountry(id: number, name: string): Promise<number> {
  await pool.query(
    `INSERT INTO setes_central.tb_country (id, name, created_at, updated_at)
     VALUES (?, ?, NOW(), NOW())`,
    [id, name]
  )
  return id
}

export async function updateCountry(id: number, name: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_country SET name = ?, updated_at = NOW() WHERE id = ?`,
    [name, id]
  )
}

export async function deleteCountry(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_country SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

// =====================================================================
// State
// =====================================================================

export async function listStates(filter: string, countryId?: number): Promise<StateRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT s.id,
            s.tb_country_id AS tbCountryId,
            s.abbreviation,
            s.name,
            s.aliquota,
            c.name          AS countryName
     FROM setes_central.tb_state s
     LEFT JOIN setes_central.tb_country c ON c.id = s.tb_country_id
     WHERE s.deleted = 'N'
       AND (? IS NULL OR s.name LIKE ? OR s.abbreviation LIKE ?)
       AND (? IS NULL OR s.tb_country_id = ?)
     ORDER BY s.name
     LIMIT 200`,
    [like, like, like, countryId ?? null, countryId ?? null]
  )
  return rows
}

export async function getState(id: number): Promise<StateRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT s.id, s.tb_country_id AS tbCountryId, s.abbreviation, s.name,
            s.aliquota, c.name AS countryName
     FROM setes_central.tb_state s
     LEFT JOIN setes_central.tb_country c ON c.id = s.tb_country_id
     WHERE s.id = ? AND s.deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Verifica se já existe estado com o id — INCLUINDO registros com deleted='S'.
 * O código do estado é o código IBGE da UF (ex.: Paraná 41, São Paulo 35) e
 * nunca é reaproveitado, mesmo após exclusão lógica (decisão do Valdo, 2026-07-11).
 */
export async function stateIdExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_state WHERE id = ?`,
    [id]
  )
  return rows.length > 0
}

/**
 * Insere estado com o id INFORMADO (código IBGE da UF) — não há geração
 * sequencial para tb_state (decisão do Valdo, 2026-07-11).
 */
export async function insertState(id: number, input: StateInput): Promise<number> {
  await pool.query(
    `INSERT INTO setes_central.tb_state
       (id, tb_country_id, abbreviation, name, aliquota, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [id, input.tbCountryId, input.abbreviation, input.name, input.aliquota ?? null]
  )
  return id
}

export async function updateState(id: number, input: StateInput): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_state
     SET tb_country_id = ?, abbreviation = ?, name = ?, aliquota = ?, updated_at = NOW()
     WHERE id = ?`,
    [input.tbCountryId, input.abbreviation, input.name, input.aliquota ?? null, id]
  )
}

export async function deleteState(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_state SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

// =====================================================================
// City
// =====================================================================

export async function listCities(filter: string, stateId?: number): Promise<CityRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT c.id,
            c.tb_state_id  AS tbStateId,
            c.ibge,
            c.name,
            c.aliq_iss     AS aliqIss,
            c.population,
            c.density,
            c.area,
            s.name         AS stateName
     FROM setes_central.tb_city c
     LEFT JOIN setes_central.tb_state s ON s.id = c.tb_state_id
     WHERE c.deleted = 'N'
       AND (? IS NULL OR c.name LIKE ?)
       AND (? IS NULL OR c.tb_state_id = ?)
     ORDER BY c.name
     LIMIT 200`,
    [like, like, stateId ?? null, stateId ?? null]
  )
  return rows
}

export async function getCity(id: number): Promise<CityRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT c.id, c.tb_state_id AS tbStateId, c.ibge, c.name,
            c.aliq_iss AS aliqIss, c.population, c.density, c.area,
            s.name AS stateName
     FROM setes_central.tb_city c
     LEFT JOIN setes_central.tb_state s ON s.id = c.tb_state_id
     WHERE c.id = ? AND c.deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Verifica se já existe cidade com o id — INCLUINDO registros com deleted='S'.
 * O código da cidade é o código IBGE do município (ex.: Curitiba 4004) e
 * nunca é reaproveitado, mesmo após exclusão lógica (decisão do Valdo, 2026-07-11).
 */
export async function cityIdExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_city WHERE id = ?`,
    [id]
  )
  return rows.length > 0
}

/**
 * Insere cidade com o id INFORMADO (código IBGE do município) — não há geração
 * sequencial para tb_city (decisão do Valdo, 2026-07-11).
 */
export async function insertCity(input: CityCreateInput): Promise<number> {
  await pool.query(
    `INSERT INTO setes_central.tb_city
       (id, tb_state_id, ibge, name, aliq_iss, population, density, area, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      input.id,
      input.tbStateId,
      input.ibge ?? null,
      input.name,
      input.aliqIss  ?? 0,
      input.population ?? 0,
      input.density  ?? 0,
      input.area     ?? 0,
    ]
  )
  return input.id
}

export async function updateCity(id: number, input: CityInput): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_city
     SET tb_state_id = ?, ibge = ?, name = ?,
         aliq_iss = ?, population = ?, density = ?, area = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [
      input.tbStateId,
      input.ibge ?? null,
      input.name,
      input.aliqIss  ?? 0,
      input.population ?? 0,
      input.density  ?? 0,
      input.area     ?? 0,
      id,
    ]
  )
}

export async function deleteCity(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_city SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

// =====================================================================
// Interface (tb_interface + tb_interface_has_privilege)
// ATENÇÃO: GET /api/core/menus também lê tb_interface — este repositório
// só ATENDE o CRUD do Super, sem tocar naquele endpoint.
// =====================================================================

/**
 * Busca os privilégios ativos (deleted='N' e active='S') das interfaces
 * informadas, agregados por interface — alimenta o campo privilegeIds.
 */
async function privilegeIdsByInterface(interfaceIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>()
  if (interfaceIds.length === 0) return map
  const [rows] = await pool.query<any[]>(
    `SELECT tb_interface_id AS interfaceId, tb_privilege_id AS privilegeId
     FROM setes_central.tb_interface_has_privilege
     WHERE deleted = 'N' AND active = 'S' AND tb_interface_id IN (?)
     ORDER BY tb_privilege_id`,
    [interfaceIds]
  )
  for (const row of rows) {
    const list = map.get(row.interfaceId) ?? []
    list.push(row.privilegeId)
    map.set(row.interfaceId, list)
  }
  return map
}

export async function listInterfaces(filter: string): Promise<InterfaceRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            i.group_default AS groupDefault,
            i.i18n_key      AS i18nKey,
            i.description,
            i.kind,
            i.\`position\`
     FROM setes_central.tb_interface i
     WHERE i.deleted = 'N'
       AND (? IS NULL OR i.description LIKE ? OR i.i18n_key LIKE ? OR i.group_default LIKE ?)
     ORDER BY i.description
     LIMIT 200`,
    [like, like, like, like]
  )
  const privileges = await privilegeIdsByInterface(rows.map((r) => r.id))
  return rows.map((row) => ({ ...row, privilegeIds: privileges.get(row.id) ?? [] }))
}

export async function getInterface(id: number): Promise<InterfaceRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            i.group_default AS groupDefault,
            i.i18n_key      AS i18nKey,
            i.description,
            i.kind,
            i.\`position\`
     FROM setes_central.tb_interface i
     WHERE i.id = ? AND i.deleted = 'N'`,
    [id]
  )
  const row = rows[0]
  if (!row) return null
  const privileges = await privilegeIdsByInterface([id])
  return { ...row, privilegeIds: privileges.get(id) ?? [] }
}

/**
 * Insere interface com id gerado MAX(id)+1 (COALESCE p/ tabela vazia) —
 * tb_interface NÃO tem auto_increment e não há padrão externo de código
 * (decisão do Valdo, 2026-07-11).
 */
export async function insertInterface(input: InterfaceInput): Promise<number> {
  const [rows] = await pool.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_interface`
  )
  const id: number = rows[0].nextId
  await pool.query(
    `INSERT INTO setes_central.tb_interface
       (id, group_default, i18n_key, description, kind, \`position\`, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      id,
      input.groupDefault ?? null,
      input.i18nKey      ?? null,
      input.description,
      input.kind         ?? null,
      input.position     ?? null,
    ]
  )
  return id
}

/** Atualiza a interface — o id nunca muda. */
export async function updateInterface(id: number, input: InterfaceInput): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_interface
     SET group_default = ?, i18n_key = ?, description = ?, kind = ?, \`position\` = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [
      input.groupDefault ?? null,
      input.i18nKey      ?? null,
      input.description,
      input.kind         ?? null,
      input.position     ?? null,
      id,
    ]
  )
}

export async function deleteInterface(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_interface SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

/**
 * Sincroniza tb_interface_has_privilege com os ids selecionados na tela:
 * selecionados → INSERT ... ON DUPLICATE KEY UPDATE active='S', deleted='N'
 * (reativa vínculo excluído logicamente); não selecionados → deleted='S'.
 */
export async function syncInterfacePrivileges(
  interfaceId: number,
  privilegeIds: number[]
): Promise<void> {
  if (privilegeIds.length > 0) {
    const values = privilegeIds.map(() => `(?, ?, 'S', NOW(), NOW(), 'N')`).join(', ')
    const params = privilegeIds.flatMap((privilegeId) => [interfaceId, privilegeId])
    await pool.query(
      `INSERT INTO setes_central.tb_interface_has_privilege
         (tb_interface_id, tb_privilege_id, active, created_at, updated_at, deleted)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N', updated_at = NOW()`,
      params
    )
    await pool.query(
      `UPDATE setes_central.tb_interface_has_privilege
       SET deleted = 'S', updated_at = NOW()
       WHERE tb_interface_id = ? AND deleted = 'N' AND tb_privilege_id NOT IN (?)`,
      [interfaceId, privilegeIds]
    )
  } else {
    await pool.query(
      `UPDATE setes_central.tb_interface_has_privilege
       SET deleted = 'S', updated_at = NOW()
       WHERE tb_interface_id = ? AND deleted = 'N'`,
      [interfaceId]
    )
  }
}

// =====================================================================
// Privilege (tb_privilege) — CRUD do cadastro de Privilégios (setes-app)
// e lista de apoio dos checkboxes da tela de Interfaces (labels =
// description direto do banco, sem tradução).
// =====================================================================

export async function listPrivileges(filter: string): Promise<PrivilegeRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, description
     FROM setes_central.tb_privilege
     WHERE deleted = 'N'
       AND (? IS NULL OR description LIKE ?)
     ORDER BY id
     LIMIT 200`,
    [like, like]
  )
  return rows
}

export async function getPrivilege(id: number): Promise<PrivilegeRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT id, description
     FROM setes_central.tb_privilege
     WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Insere privilégio com id gerado MAX(id)+1 (COALESCE p/ tabela vazia) —
 * tb_privilege NÃO tem auto_increment e não há padrão externo de código
 * (mesma decisão do cadastro de Interfaces — Valdo, 2026-07-11).
 */
export async function insertPrivilege(description: string): Promise<number> {
  const [rows] = await pool.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_privilege`
  )
  const id: number = rows[0].nextId
  await pool.query(
    `INSERT INTO setes_central.tb_privilege (id, description, created_at, updated_at)
     VALUES (?, ?, NOW(), NOW())`,
    [id, description]
  )
  return id
}

/** Atualiza a description — o id nunca muda. */
export async function updatePrivilege(id: number, description: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_privilege
     SET description = ?, updated_at = NOW()
     WHERE id = ?`,
    [description, id]
  )
}

export async function deletePrivilege(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_privilege SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}
