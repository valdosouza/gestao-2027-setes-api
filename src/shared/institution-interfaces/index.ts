import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { escapeLike, ListQuery, PagedRows } from '@shared/list'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'

/**
 * Vínculo ESTABELECIMENTO × INTERFACES (`tb_institution_has_interface` — o "contrato de interfaces": quais telas cada cliente tem;
 * decisões 17/18/23 da Fase 1). Peça ÚNICA de leitura e escrita desde a D-PV11 (2026-10-18 — prompt_privilegios_interfaces.md):
 * dois consumidores — a aba Interfaces do cadastro de Estabelecimento (Super, `/api/admin`) e a tela "Interfaces dos clientes"
 * (`/api/institution-interfaces`, delegável pelo Super a usuário da Setes). Duas telas, UMA regra de escrita.
 *
 * O contrato da institution ALVO é lido pela chave DELA — nunca o schema inteiro (D-GE4: com 2 institutions no schema, sem o filtro
 * a tela mostraria o contratado da outra e o salvar o copiaria). Hoje 1 institution por schema; na onda 1 do grupo a chave vira a do
 * grupo (D-GE22).
 */

export async function getInstitutionSchemaName(institutionId: number): Promise<string | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT schema_name AS schemaName
     FROM setes_central.tb_institution
     WHERE id = ? AND deleted = 'N'`,
    [institutionId]
  )
  return rows[0]?.schemaName ?? null
}

export interface InterfaceGrantRow {
  id:           number
  description:  string | null
  groupDefault: string | null
  kind:         string | null
  granted:      boolean
}

/** Catálogo completo (central) + situação do contrato da institution ALVO (pela chave dela — D-GE4). */
export async function listInterfacesWithGrant(schemaName: string, institutionId: number): Promise<InterfaceGrantRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            i.description,
            i.group_default AS groupDefault,
            i.kind,
            CASE WHEN ihi.tb_interface_id IS NOT NULL THEN TRUE ELSE FALSE END AS granted
     FROM setes_central.tb_interface i
     LEFT JOIN \`${s}\`.tb_institution_has_interface ihi
       ON (ihi.tb_interface_id = i.id AND ihi.tb_institution_id = ?
           AND ihi.active = 'S' AND ihi.deleted = 'N')
     WHERE i.deleted = 'N'
     ORDER BY i.group_default, i.description`,
    [institutionId]
  )
  return rows.map(r => ({ ...r, granted: Boolean(r.granted) }))
}

/** O que a gravação mudou — a TRILHA (quem chama registra com o autor; gate socrático da D-PV11). */
export interface InterfaceGrantChange { added: number[]; removed: number[] }

/**
 * Sincroniza o contrato: concede as interfaces da lista, revoga (soft) as demais. Regra ÚNICA das duas portas (aba do Super e tela
 * delegável): sem repetidos, só interface VIVA do catálogo (400 no campo `interfaceIds`), e devolve a diferença para a trilha.
 */
export async function setInstitutionInterfaces(
  schemaName: string, institutionId: number, interfaceIdsIn: number[]
): Promise<InterfaceGrantChange> {
  const s    = assertSchema(schemaName)
  const interfaceIds = [...new Set(interfaceIdsIn)]
  if (interfaceIds.length > 0) {
    const [known] = await pool.query<any[]>(
      `SELECT id FROM setes_central.tb_interface WHERE deleted = 'N' AND id IN (?)`, [interfaceIds]
    )
    const alive = new Set(known.map(r => Number(r.id)))
    const unknown = interfaceIds.filter(id => !alive.has(id))
    if (unknown.length > 0) {
      throw new HttpError(400, 'Interface fora do catálogo',
        [{ field: 'interfaceIds', message: `Fora do catálogo: ${unknown.join(', ')}` }], ErrorCodes.VALIDATION_FAILED)
    }
  }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [current] = await conn.query<any[]>(
      `SELECT tb_interface_id AS id FROM \`${s}\`.tb_institution_has_interface
        WHERE tb_institution_id = ? AND active = 'S' AND deleted = 'N' FOR UPDATE`,
      [institutionId]
    )
    const before = new Set(current.map(r => Number(r.id)))
    const after = new Set(interfaceIds)

    if (interfaceIds.length > 0) {
      const values = interfaceIds.map(id => [institutionId, id, 'S', new Date(), new Date()])
      await conn.query(
        `INSERT INTO \`${s}\`.tb_institution_has_interface
           (tb_institution_id, tb_interface_id, active, created_at, updated_at)
         VALUES ?
         ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N', updated_at = NOW()`,
        [values]
      )
      await conn.query(
        `UPDATE \`${s}\`.tb_institution_has_interface
         SET active = 'N', updated_at = NOW()
         WHERE tb_institution_id = ? AND tb_interface_id NOT IN (?)`,
        [institutionId, interfaceIds]
      )
    } else {
      await conn.query(
        `UPDATE \`${s}\`.tb_institution_has_interface
         SET active = 'N', updated_at = NOW()
         WHERE tb_institution_id = ?`,
        [institutionId]
      )
    }

    await conn.commit()
    return {
      added: interfaceIds.filter(id => !before.has(id)),
      removed: [...before].filter(id => !after.has(id)),
    }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export interface ClientInstitutionRow { id: number; name: string | null; active: string }

/**
 * Estabelecimentos clientes, PAGINADO (regra: lista nova nasce paginada). `excludeId` tira um estabelecimento da lista (a tela
 * delegada não mostra a própria Setes — D-PV11 (c)).
 */
export async function listClientInstitutions(
  query: ListQuery, excludeId: number | null
): Promise<PagedRows<ClientInstitutionRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_institution i
     INNER JOIN setes_central.tb_entity e ON e.id = i.id
     WHERE i.deleted = 'N'
       AND (? IS NULL OR i.id <> ?)
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)`
  const params = [excludeId, excludeId, like, like, like]
  const [rows] = await pool.query<any[]>(
    `SELECT i.id, COALESCE(NULLIF(e.nick_trade, ''), e.name_company) AS name, i.active
     ${where}
     ORDER BY name, i.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(`SELECT COUNT(*) AS total ${where}`, params)
  return { rows: rows.map(r => ({ id: Number(r.id), name: r.name ?? null, active: String(r.active) })), total: Number(count[0].total) }
}
