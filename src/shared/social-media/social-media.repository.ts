import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { SocialMediaInput, SocialMediaRow } from './social-media.types'

/**
 * Persistência de REDES SOCIAIS (tb_social_media, setes_central — PK id+kind).
 * Peça independente (SRP): só conhece a própria tabela; o vínculo com a
 * entity é o [entityId] recebido por parâmetro. Escrita é TRANSACTION-AWARE
 * (conn da transação aberta pelo chamador).
 */

/** Diff por kind: upsert dos enviados, deleted='S' nos ausentes (nunca DELETE). */
export async function syncSocialMedia(
  conn: PoolConnection, entityId: number, socialMedia: SocialMediaInput[]
): Promise<void> {
  for (const s of socialMedia) {
    await conn.query(
      `INSERT INTO setes_central.tb_social_media (id, kind, link, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         link = VALUES(link), deleted = 'N', updated_at = NOW()`,
      [entityId, s.kind, s.link ?? null]
    )
  }
  const kinds = socialMedia.map(s => s.kind)
  if (kinds.length > 0) {
    await conn.query(
      `UPDATE setes_central.tb_social_media SET deleted = 'S', updated_at = NOW()
       WHERE id = ? AND kind NOT IN (?)`,
      [entityId, kinds]
    )
  } else {
    await conn.query(
      `UPDATE setes_central.tb_social_media SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [entityId]
    )
  }
}

/** Redes sociais vivas da entity. */
export async function listSocialMedia(entityId: number): Promise<SocialMediaRow[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT kind, link
     FROM setes_central.tb_social_media WHERE id = ? AND deleted = 'N' ORDER BY kind`,
    [entityId]
  )
  return rows as SocialMediaRow[]
}
