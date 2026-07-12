import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import {
  InstitutionInput, InstitutionListRow, InstitutionFull,
  AddressRow, PhoneRow, SocialMediaRow,
} from './institutions.interface'

/**
 * Repositório do cadastro de Estabelecimento (Institution) — cadeia de
 * entidade fiscal (skill cadastro-entidade-fiscal.md):
 * tb_entity → tb_person|tb_company → tb_address/tb_phone/tb_social_media
 * → tb_institution, TUDO em transação única. Os JOINs de país/UF/cidade
 * são relação de BANCO (exibição no app) — não acoplam módulos.
 */

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export async function listInstitutions(filter: string): Promise<InstitutionListRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            e.nick_trade   AS nickTrade,
            e.name_company AS nameCompany,
            i.schema_name  AS schemaName,
            i.active
     FROM setes_central.tb_institution i
     INNER JOIN setes_central.tb_entity e ON e.id = i.id
     WHERE i.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR i.schema_name LIKE ?)
     ORDER BY e.nick_trade
     LIMIT 200`,
    [like, like, like, like]
  )
  return rows
}

/** Objeto COMPLETO: entity + fiscal + 3 listas (deleted='N') + institution. */
export async function getInstitution(id: number): Promise<InstitutionFull | null> {
  const [main] = await pool.query<any[]>(
    `SELECT i.id,
            e.name_company AS nameCompany,
            e.nick_trade   AS nickTrade,
            DATE_FORMAT(e.aniversary, '%Y-%m-%d') AS aniversary,
            i.schema_name  AS schemaName,
            i.active
     FROM setes_central.tb_institution i
     INNER JOIN setes_central.tb_entity e ON e.id = i.id
     WHERE i.id = ? AND i.deleted = 'N'`,
    [id]
  )
  if (!main[0]) return null

  const [persons] = await pool.query<any[]>(
    `SELECT cpf, rg, DATE_FORMAT(birthday, '%Y-%m-%d') AS birthday
     FROM setes_central.tb_person WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  const [companies] = await pool.query<any[]>(
    `SELECT cnpj, ie, im, DATE_FORMAT(dt_foundation, '%Y-%m-%d') AS dtFoundation
     FROM setes_central.tb_company WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  const [addresses] = await pool.query<any[]>(
    `SELECT a.kind, a.street, a.nmbr, a.complement, a.neighborhood,
            a.zip_code      AS zipCode,
            a.tb_country_id AS tbCountryId,
            a.tb_state_id   AS tbStateId,
            a.tb_city_id    AS tbCityId,
            a.main,
            co.name         AS countryName,
            st.name         AS stateName,
            ci.name         AS cityName
     FROM setes_central.tb_address a
     LEFT JOIN setes_central.tb_country co ON co.id = a.tb_country_id
     LEFT JOIN setes_central.tb_state   st ON st.id = a.tb_state_id
     LEFT JOIN setes_central.tb_city    ci ON ci.id = a.tb_city_id
     WHERE a.id = ? AND a.deleted = 'N'
     ORDER BY a.kind`,
    [id]
  )
  const [phones] = await pool.query<any[]>(
    `SELECT kind, contact, number
     FROM setes_central.tb_phone WHERE id = ? AND deleted = 'N' ORDER BY kind`,
    [id]
  )
  const [socialMedia] = await pool.query<any[]>(
    `SELECT kind, link
     FROM setes_central.tb_social_media WHERE id = ? AND deleted = 'N' ORDER BY kind`,
    [id]
  )

  const row = main[0]
  return {
    id:         row.id,
    entity: {
      nameCompany: row.nameCompany,
      nickTrade:   row.nickTrade,
      aniversary:  row.aniversary,
    },
    personType:  persons[0] ? 'F' : 'J',
    person:      persons[0] ?? null,
    company:     companies[0] ?? null,
    addresses:   addresses as AddressRow[],
    phones:      phones as PhoneRow[],
    socialMedia: socialMedia as SocialMediaRow[],
    schemaName:  row.schemaName,
    active:      row.active,
  }
}

/** schema_name é UNIQUE e nunca reaproveitado — verifica INCLUINDO deleted='S'. */
export async function schemaNameExists(schemaName: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    'SELECT schema_name FROM setes_central.tb_institution WHERE schema_name = ?',
    [schemaName]
  )
  return rows.length > 0
}

export async function institutionExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    "SELECT id FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'",
    [id]
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------
// Cascade (transação única) — passos da skill cadastro-entidade-fiscal.md
// ---------------------------------------------------------------------

/** Toggle fiscal: upsert da especialização escolhida, soft delete da outra. */
async function upsertFiscal(conn: PoolConnection, id: number, input: InstitutionInput): Promise<void> {
  if (input.personType === 'F') {
    await conn.query(
      `INSERT INTO setes_central.tb_person (id, cpf, rg, birthday, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         cpf = VALUES(cpf), rg = VALUES(rg), birthday = VALUES(birthday),
         deleted = 'N', updated_at = NOW()`,
      [id, input.person!.cpf, input.person!.rg ?? null, input.person!.birthday ?? null]
    )
    await conn.query(
      `UPDATE setes_central.tb_company SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [id]
    )
  } else {
    await conn.query(
      `INSERT INTO setes_central.tb_company (id, cnpj, ie, im, dt_foundation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         cnpj = VALUES(cnpj), ie = VALUES(ie), im = VALUES(im),
         dt_foundation = VALUES(dt_foundation), deleted = 'N', updated_at = NOW()`,
      [id, input.company!.cnpj, input.company!.ie ?? null, input.company!.im ?? null,
       input.company!.dtFoundation ?? null]
    )
    await conn.query(
      `UPDATE setes_central.tb_person SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [id]
    )
  }
}

/**
 * Diff por kind nas 3 listas de apoio (PK id+kind): upsert dos enviados,
 * deleted='S' nos kinds que sumiram do payload (nunca DELETE físico).
 */
async function syncKindLists(conn: PoolConnection, id: number, input: InstitutionInput): Promise<void> {
  // Endereços
  for (const a of input.addresses) {
    await conn.query(
      `INSERT INTO setes_central.tb_address
         (id, kind, street, nmbr, complement, neighborhood, zip_code,
          tb_country_id, tb_state_id, tb_city_id, main, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         street = VALUES(street), nmbr = VALUES(nmbr), complement = VALUES(complement),
         neighborhood = VALUES(neighborhood), zip_code = VALUES(zip_code),
         tb_country_id = VALUES(tb_country_id), tb_state_id = VALUES(tb_state_id),
         tb_city_id = VALUES(tb_city_id), main = VALUES(main),
         deleted = 'N', updated_at = NOW()`,
      [id, a.kind, a.street, a.nmbr ?? 'sn', a.complement ?? null, a.neighborhood ?? null,
       a.zipCode ?? null, a.tbCountryId, a.tbStateId, a.tbCityId, a.main ?? 'S']
    )
  }
  const addressKinds = input.addresses.map(a => a.kind)
  if (addressKinds.length > 0) {
    await conn.query(
      `UPDATE setes_central.tb_address SET deleted = 'S', updated_at = NOW()
       WHERE id = ? AND kind NOT IN (?)`,
      [id, addressKinds]
    )
  } else {
    await conn.query(
      `UPDATE setes_central.tb_address SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [id]
    )
  }

  // Fones (tb_phone — SINGULAR)
  for (const p of input.phones) {
    await conn.query(
      `INSERT INTO setes_central.tb_phone (id, kind, contact, number, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         contact = VALUES(contact), number = VALUES(number),
         deleted = 'N', updated_at = NOW()`,
      [id, p.kind, p.contact ?? null, p.number ?? null]
    )
  }
  const phoneKinds = input.phones.map(p => p.kind)
  if (phoneKinds.length > 0) {
    await conn.query(
      `UPDATE setes_central.tb_phone SET deleted = 'S', updated_at = NOW()
       WHERE id = ? AND kind NOT IN (?)`,
      [id, phoneKinds]
    )
  } else {
    await conn.query(
      `UPDATE setes_central.tb_phone SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [id]
    )
  }

  // Redes sociais
  for (const s of input.socialMedia) {
    await conn.query(
      `INSERT INTO setes_central.tb_social_media (id, kind, link, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         link = VALUES(link), deleted = 'N', updated_at = NOW()`,
      [id, s.kind, s.link ?? null]
    )
  }
  const socialKinds = input.socialMedia.map(s => s.kind)
  if (socialKinds.length > 0) {
    await conn.query(
      `UPDATE setes_central.tb_social_media SET deleted = 'S', updated_at = NOW()
       WHERE id = ? AND kind NOT IN (?)`,
      [id, socialKinds]
    )
  } else {
    await conn.query(
      `UPDATE setes_central.tb_social_media SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [id]
    )
  }
}

/**
 * POST: cadeia inteira em transação única. id = MAX+1 em tb_entity com
 * FOR UPDATE (decisão 7 da Fase 2). A institution nasce active='N' —
 * quem ativa é a migração do schema, DEPOIS do commit (DDL não tem rollback).
 */
export async function insertInstitutionCascade(
  input: InstitutionInput, schemaName: string
): Promise<number> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      'SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_entity FOR UPDATE'
    )
    const id = Number(rows[0].nextId)

    await conn.query(
      `INSERT INTO setes_central.tb_entity
         (id, name_company, nick_trade, aniversary, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [id, input.entity.nameCompany, input.entity.nickTrade, input.entity.aniversary ?? null]
    )

    await upsertFiscal(conn, id, input)
    await syncKindLists(conn, id, input)

    await conn.query(
      `INSERT INTO setes_central.tb_institution (id, schema_name, active, created_at, updated_at)
       VALUES (?, ?, 'N', NOW(), NOW())`,
      [id, schemaName]
    )

    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** PUT: mesma cascade em transação única. schema_name é IMUTÁVEL. */
export async function updateInstitutionCascade(
  id: number, input: InstitutionInput
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await conn.query(
      `UPDATE setes_central.tb_entity
       SET name_company = ?, nick_trade = ?, aniversary = ?, updated_at = NOW()
       WHERE id = ?`,
      [input.entity.nameCompany, input.entity.nickTrade, input.entity.aniversary ?? null, id]
    )

    await upsertFiscal(conn, id, input)
    await syncKindLists(conn, id, input)

    if (input.active !== undefined) {
      await conn.query(
        `UPDATE setes_central.tb_institution SET active = ?, updated_at = NOW() WHERE id = ?`,
        [input.active, id]
      )
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function setInstitutionActive(id: number, active: 'S' | 'N'): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_institution SET active = ?, updated_at = NOW() WHERE id = ?`,
    [active, id]
  )
}

/** Soft delete da institution — a cadeia entity permanece. */
export async function deleteInstitution(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_institution SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

/**
 * Feature flags padrão do onboarding (gate técnico — decisão 17). Veio do
 * antigo admin.repository quando o cadastro absorveu o onboarding
 * (decisão do Valdo, 2026-07-11).
 */
export async function insertDefaultFlags(institutionId: number): Promise<void> {
  const defaultModules = ['core']
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      'SELECT COALESCE(MAX(id), 0) AS maxId FROM setes_central.tb_feature_flag FOR UPDATE'
    )
    let nextId = Number(rows[0].maxId)

    const now    = new Date()
    const values = defaultModules.map(mod => [++nextId, institutionId, mod, true, now, now])

    await conn.query(
      `INSERT INTO setes_central.tb_feature_flag
         (id, tb_institution_id, module_key, enabled, created_at, updated_at)
       VALUES ?`,
      [values]
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
