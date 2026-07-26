import { Router, Request, Response } from 'express'
import { syncAuthMiddleware } from './sync.auth.middleware'
import { processPush, processPull } from './sync.service'
import { getQueueStatus } from './sync.queue'
import logger from '@shared/logger/logger'

const router = Router()

// Todas as rotas de sync exigem API Key
router.use(syncAuthMiddleware)

/**
 * @swagger
 * /sync/push:
 *   post:
 *     summary: Push de dados para a API (até 5.000 registros por requisição)
 *     description: Sincronizador enfileira lotes >5.000 para processamento assíncrono
 *     tags: [Sync]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               table:
 *                 type: string
 *               records:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 5000
 *     responses:
 *       200:
 *         description: Registros processados imediatamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 queued:
 *                   type: boolean
 *                   example: false
 *                 data:
 *                   type: object
 *       202:
 *         description: Lote >5.000 registros enfileirado
 *       400:
 *         description: Validação do corpo falhou
 *       401:
 *         description: API Key inválida
 *       500:
 *         description: Erro interno
 */
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

/**
 * @swagger
 * /sync/pull:
 *   get:
 *     summary: Pull de dados da API (setes_sync)
 *     description: Retorna registros alterados desde `since`
 *     tags: [Sync]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - name: table
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *       - name: since
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 500
 *           maximum: 500
 *     responses:
 *       200:
 *         description: Registros retornados
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 data:
 *                   type: array
 *       400:
 *         description: Parâmetros ausentes ou inválidos
 *       401:
 *         description: API Key inválida
 *       500:
 *         description: Erro interno
 */
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

/**
 * @swagger
 * /sync/status:
 *   get:
 *     summary: Status da conexão e fila de processamento
 *     tags: [Sync]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Status da fila e cliente autenticado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 client:
 *                   type: object
 *                 queue:
 *                   type: object
 *       401:
 *         description: API Key inválida
 */
router.get('/status', (req: Request, res: Response) => {
  res.json({
    ok:     true,
    client: req.syncClient,
    queue:  getQueueStatus(),
  })
})

/**
 * @swagger
 * /sync/log:
 *   get:
 *     summary: Histórico de operações de sync
 *     tags: [Sync]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Lista de operações de sync
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 data:
 *                   type: array
 *       401:
 *         description: API Key inválida
 *       500:
 *         description: Erro ao buscar log
 */
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
