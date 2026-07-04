import { Router, Request, Response } from 'express'
import { onboardTenant } from './admin.service'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

// Middleware local: bloqueia quem não for setes_admin
router.use((req: Request, res: Response, next) => {
  if (req.tenant?.role !== 'setes_admin') {
    res.status(403).json({ error: 'Acesso restrito à equipe Setes' })
    return
  }
  next()
})

// POST /api/admin/tenants
router.post('/tenants', async (req: Request, res: Response) => {
  const { name, schemaName } = req.body

  if (!name || !schemaName) {
    res.status(400).json({ error: 'Os campos "name" e "schemaName" são obrigatórios' })
    return
  }

  try {
    const result = await onboardTenant({ name, schemaName })
    logger.info('Novo tenant criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    logger.error('Erro ao criar tenant', { err })
    res.status(500).json({ error: 'Erro interno ao criar tenant' })
  }
})

// GET /api/admin/tenants
router.get('/tenants', async (_req: Request, res: Response) => {
  const pool = (await import('@shared/db/connection')).default
  try {
    const [rows] = await pool.query<any[]>(
      'SELECT id, name, schema_name, active, created_at FROM setes_central.tenants ORDER BY created_at DESC'
    )
    res.json({ ok: true, data: rows })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar tenants' })
  }
})

export default router
