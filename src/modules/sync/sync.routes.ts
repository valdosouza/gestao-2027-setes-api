import { Router, Request, Response } from 'express'
import { syncAuthMiddleware } from './sync.auth.middleware'
import { processPush, processPull } from './sync.service'
import { getQueueStatus } from './sync.queue'
import logger from '@shared/logger/logger'

const router = Router()

// Todas as rotas de sync exigem API Key
router.use(syncAuthMiddleware)

// POST /sync/push
router.post('/push', async (req: Request, res: Response) => {
  const { table, records } = req.body
  const client = req.syncClient!

  if (!table || typeof table !== 'string') {
    res.status(400).json({ error: 'Campo "table" obrigatorio' })
    return
  }

  if (!Array.isArray(records) || records.length === 0) {
    res.status(400).json({ error: 'Campo "records" deve ser um array nao vazio' })
    return
  }

  if (records.length > 5000) {
    res.status(400).json({ error: 'Maximo de 5.000 registros por requisicao' })
    return
  }

  try {
    const result = await processPush(client.schemaName, client.establishmentCode, {
      table,
      records,
    })

    const status = result.queued ? 202 : 200
    res.status(status).json({
      ok:     true,
      queued: result.queued,
      data:   result.queued
        ? { message: 'Lote grande enfileirado para processamento' }
        : { inserted: result.inserted, updated: result.updated },
    })
  } catch (err: any) {
    logger.error('Erro no push', { err, establishment: client.establishmentCode })
    res.status(500).json({ error: err.message ?? 'Erro interno no push' })
  }
})

// GET /sync/pull?table=tb_product&since=2024-01-01T00:00:00&limit=500
router.get('/pull', async (req: Request, res: Response) => {
  const { table, since, limit } = req.query
  const client = req.syncClient!

  if (!table || typeof table !== 'string') {
    res.status(400).json({ error: 'Query param "table" obrigatorio' })
    return
  }

  if (!since || typeof since !== 'string') {
    res.status(400).json({ error: 'Query param "since" obrigatorio (ISO datetime)' })
    return
  }

  if (isNaN(Date.parse(since))) {
    res.status(400).json({ error: '"since" deve ser um datetime valido (ex: 2024-01-01T00:00:00)' })
    return
  }

  try {
    const result = await processPull(client.schemaName, client.establishmentCode, {
      table,
      since,
      limit: limit ? Math.min(Number(limit), 500) : 500,
    })

    res.json({ ok: true, data: result })
  } catch (err: any) {
    logger.error('Erro no pull', { err, establishment: client.establishmentCode })
    res.status(500).json({ error: err.message ?? 'Erro interno no pull' })
  }
})

// GET /sync/status
router.get('/status', (req: Request, res: Response) => {
  res.json({
    ok:     true,
    client: req.syncClient,
    queue:  getQueueStatus(),
  })
})

// GET /sync/log?limit=20
router.get('/log', async (req: Request, res: Response) => {
  const client = req.syncClient!
  const limit  = Math.min(Number(req.query.limit ?? 20), 100)

  try {
    const pool = (await import('@shared/db/connection')).default
    const [rows] = await pool.query<any[]>(
      `SELECT direction, table_name, records_count, status,
              error_message, duration_ms, created_at
       FROM setes_central.sync_log
       WHERE establishment_code = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [client.establishmentCode, limit]
    )
    res.json({ ok: true, data: rows })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar log' })
  }
})

export default router
