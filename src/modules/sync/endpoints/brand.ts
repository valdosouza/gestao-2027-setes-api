import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextGlobalId } from '../sync.id-generator'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/brand/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const { tb_institution_id, Marca } = req.body
    let brandId: number

    if (Marca.id > 0) {
      const [existing] = await conn.query<any[]>(
        `SELECT id FROM tb_brand WHERE id = ? LIMIT 1`, [Marca.id]
      )
      if (existing.length) {
        await conn.query(
          `UPDATE tb_brand SET description = ?, updated_at = NOW() WHERE id = ?`,
          [Marca.description, Marca.id]
        )
        brandId = Marca.id
      } else {
        await conn.query(
          `INSERT INTO tb_brand (id, description, created_at, updated_at) VALUES (?, ?, NOW(), NOW())`,
          [Marca.id, Marca.description]
        )
        brandId = Marca.id
      }
    } else {
      const [rows] = await conn.query<any[]>(
        `SELECT id FROM tb_brand WHERE description = ? LIMIT 1`, [Marca.description]
      )
      if (rows.length) {
        brandId = rows[0].id
      } else {
        brandId = await nextGlobalId(conn, 'tb_brand')
        await conn.query(
          `INSERT INTO tb_brand (id, description, created_at, updated_at) VALUES (?, ?, NOW(), NOW())`,
          [brandId, Marca.description]
        )
      }
    }

    await conn.query(
      `INSERT INTO tb_institution_has_brand (tb_institution_id, tb_brand_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE tb_brand_id = tb_brand_id`,
      [tb_institution_id, brandId]
    )

    await conn.commit()
    res.json(syncSuccess(tb_institution_id))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /brand/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
