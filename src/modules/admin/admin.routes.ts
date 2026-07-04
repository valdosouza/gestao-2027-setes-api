import { Router, Request, Response } from 'express'
import { onboardInstitution } from './admin.service'
import { isSuper } from '@shared/auth/roles'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

// Middleware local: bloqueia quem não for superusuário da Setes (decisão 14)
router.use((req: Request, res: Response, next) => {
  if (!isSuper(req.institution)) {
    res.status(403).json({ error: 'Acesso restrito à equipe Setes' })
    return
  }
  next()
})

// POST /api/admin/institutions
router.post('/institutions', async (req: Request, res: Response) => {
  const { name, schemaName } = req.body

  if (!name || !schemaName) {
    res.status(400).json({ error: 'Os campos "name" e "schemaName" são obrigatórios' })
    return
  }

  try {
    const result = await onboardInstitution({ name, schemaName })
    logger.info('Nova institution criada', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    logger.error('Erro ao criar institution', { err })
    res.status(500).json({ error: 'Erro interno ao criar institution' })
  }
})

// GET /api/admin/institutions
router.get('/institutions', async (_req: Request, res: Response) => {
  const pool = (await import('@shared/db/connection')).default
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT i.id, e.nick_trade AS name, i.schema_name, i.active, i.created_at
       FROM setes_central.tb_institution i
       INNER JOIN setes_central.tb_entity e ON (e.id = i.id)
       WHERE i.deleted = 'N'
       ORDER BY i.created_at DESC`
    )
    res.json({ ok: true, data: rows })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar institutions' })
  }
})

export default router
