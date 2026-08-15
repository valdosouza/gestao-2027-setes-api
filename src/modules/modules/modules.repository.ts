import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { assertSchema } from '@shared/db/schema'
import { ModuleRow, ModuleInterfaceLookupRow } from './modules.interface'
import { ModuleBodyDto } from './modules.dto'

/**
 * Repositório dos MÓDULOS DE MENU (tb_module + tb_module_has_interface no
 * schema do cliente — prompt_modulo_menus.md D1–D4). Escopo = schema do JWT
 * (o Super atua no cliente trocando de institution). GROUP_CONCAT devolve
 * os vínculos NA ORDEM do menu (position — D3).
 */

/** Campos da linha + vínculos agregados NA ORDEM (D3). */
function selectFields(schema: string): string {
  return `m.id, m.description, m.position, m.image_icon AS imageIcon,
          (SELECT GROUP_CONCAT(mhi.tb_interface_id
                               ORDER BY mhi.position, mhi.tb_interface_id)
             FROM \`${schema}\`.tb_module_has_interface mhi
            WHERE mhi.tb_module_id = m.id
              AND mhi.deleted = 'N' AND mhi.active = 'S') AS interfaceIds`
}

function toRow(row: any): ModuleRow {
  return {
    id:           row.id,
    description:  row.description,
    position:     row.position,
    imageIcon:    row.imageIcon ?? null,
    interfaceIds: row.interfaceIds
      ? String(row.interfaceIds).split(',').map(Number)
      : [],
  }
}

export async function listModules(
  schemaName: string, query: ListQuery
): Promise<PagedRows<ModuleRow>> {
  const s = assertSchema(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${s}\`.tb_module m
     WHERE m.deleted = 'N'
       AND (? IS NULL OR m.description LIKE ?)`
  const params = [like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT ${selectFields(s)}
     ${where}
     ORDER BY COALESCE(m.position, 999999), m.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows: rows.map(toRow), total: Number(count[0].total) }
}

export async function getModule(schemaName: string, id: number): Promise<ModuleRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT ${selectFields(s)}
       FROM \`${s}\`.tb_module m
      WHERE m.id = ? AND m.deleted = 'N'`,
    [id]
  )
  return rows[0] ? toRow(rows[0]) : null
}

/**
 * Interfaces ELEGÍVEIS ao vínculo: contratadas (tb_institution_has_interface
 * viva), tela vendável kind='T' e FORA do grupo Super (regra do menu de
 * não-super — core.repository NOT_SUPER_GROUP).
 */
export async function listEligibleInterfaces(
  schemaName: string
): Promise<ModuleInterfaceLookupRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id, i.description, i.i18n_key AS i18nKey,
            i.group_default AS groupDefault
       FROM \`${s}\`.tb_institution_has_interface ihi
      INNER JOIN setes_central.tb_interface i
         ON (i.id = ihi.tb_interface_id AND i.deleted = 'N')
      WHERE ihi.active = 'S' AND ihi.deleted = 'N'
        AND i.kind = 'T'
        AND (i.group_default IS NULL OR i.group_default <> 'Super')
      ORDER BY i.group_default, i.description`
  )
  return rows
}

/** Ids do input que NÃO são elegíveis (base do 422 do service). */
export async function findIneligibleInterfaceIds(
  schemaName: string, interfaceIds: number[]
): Promise<number[]> {
  if (interfaceIds.length === 0) return []
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id
       FROM \`${s}\`.tb_institution_has_interface ihi
      INNER JOIN setes_central.tb_interface i
         ON (i.id = ihi.tb_interface_id AND i.deleted = 'N')
      WHERE ihi.active = 'S' AND ihi.deleted = 'N'
        AND i.kind = 'T'
        AND (i.group_default IS NULL OR i.group_default <> 'Super')
        AND i.id IN (?)`,
    [interfaceIds]
  )
  const eligible = new Set(rows.map((r: any) => r.id))
  return interfaceIds.filter(id => !eligible.has(id))
}

/**
 * Sincroniza os vínculos DENTRO da transação recebida: revoga o que saiu
 * (soft delete) e upserta o que entrou com a position = índice do array
 * (ON DUPLICATE KEY ressuscita vínculo excluído — padrão VGR).
 */
async function syncInterfaces(
  conn: any, schema: string, moduleId: number, interfaceIds: number[]
): Promise<void> {
  await conn.query(
    `UPDATE \`${schema}\`.tb_module_has_interface
        SET deleted = 'S', updated_at = NOW()
      WHERE tb_module_id = ?`,
    [moduleId]
  )
  for (let index = 0; index < interfaceIds.length; index++) {
    await conn.query(
      `INSERT INTO \`${schema}\`.tb_module_has_interface
         (tb_module_id, tb_interface_id, active, position, created_at, updated_at, deleted)
       VALUES (?, ?, 'S', ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         active = 'S', deleted = 'N', position = VALUES(position), updated_at = NOW()`,
      [moduleId, interfaceIds[index], index]
    )
  }
}

/** Cria módulo (id MAX+1 FOR UPDATE) + vínculos ordenados na MESMA transação. */
export async function insertModuleCascade(
  schemaName: string, input: ModuleBodyDto
): Promise<number> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${s}\`.tb_module FOR UPDATE`
    ) as any[]
    const id: number = rows[0].nextId
    // position omitida = fim da fila (MAX+1 da ordem atual)
    const [pos] = await conn.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS nextPos
         FROM \`${s}\`.tb_module WHERE deleted = 'N'`
    ) as any[]
    await conn.query(
      `INSERT INTO \`${s}\`.tb_module
         (id, description, position, image_icon, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, NOW(), NOW(), 'N')`,
      [id, input.description, input.position ?? pos[0].nextPos, input.imageIcon ?? null]
    )
    await syncInterfaces(conn, s, id, input.interfaceIds)
    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/**
 * Atualiza módulo + ressincroniza vínculos ordenados na MESMA transação.
 * A existência é verificada DENTRO da transação pelo próprio UPDATE
 * (WHERE deleted='N' + affectedRows — gate 2026-08-04): um PUT que cruza
 * com um DELETE não ressuscita vínculos de módulo morto.
 */
export async function updateModuleCascade(
  schemaName: string, id: number, input: ModuleBodyDto
): Promise<void> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query(
      `UPDATE \`${s}\`.tb_module
          SET description = ?, position = ?, image_icon = ?, updated_at = NOW()
        WHERE id = ? AND deleted = 'N'`,
      [input.description, input.position ?? null, input.imageIcon ?? null, id]
    ) as any[]
    if (Number(result?.affectedRows ?? 0) === 0) {
      throw new HttpError(404, `Módulo de menu ${id} não encontrado`)
    }
    await syncInterfaces(conn, s, id, input.interfaceIds)
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/**
 * Exclusão graciosa (objetivo 5): soft-delete dos vínculos + do módulo na
 * MESMA transação — as telas VOLTAM ao agrupamento por group_default no
 * menu (comportamento que o getMenus já tem; nada fica órfão).
 */
export async function deleteModuleCascade(schemaName: string, id: number): Promise<void> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // MESMA ordem de locks do update (tb_module → vínculos) — ordem
    // invertida abria janela de deadlock com PUT simultâneo (gate
    // adversarial 2026-08-04).
    await conn.query(
      `UPDATE \`${s}\`.tb_module SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [id]
    )
    await conn.query(
      `UPDATE \`${s}\`.tb_module_has_interface
          SET deleted = 'S', updated_at = NOW()
        WHERE tb_module_id = ?`,
      [id]
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
