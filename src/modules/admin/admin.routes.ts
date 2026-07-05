import { Router, Request, Response } from 'express'
import { z } from 'zod'
import {
  onboardInstitution,
  getInstitutionInterfaces, updateInstitutionInterfaces, updateFeatureFlag,
} from './admin.service'
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

// ---------------------------------------------------------------------
// setes-app Fase 1 — licenciamento de interfaces (decisões 17, 18, 23).
// O Super informa o institutionId ALVO; o schema é resolvido na central.
// ---------------------------------------------------------------------

function parseInstitutionId(req: Request, res: Response): number | null {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'institutionId inválido' })
    return null
  }
  return id
}

/**
 * @swagger
 * /api/admin/institutions/{id}/interfaces:
 *   get:
 *     summary: Catálogo de interfaces + situação do contrato do cliente alvo
 *     tags: [Admin]
 */
router.get('/institutions/:id/interfaces', async (req: Request, res: Response) => {
  const institutionId = parseInstitutionId(req, res)
  if (institutionId === null) return
  try {
    const data = await getInstitutionInterfaces(institutionId)
    res.json({ ok: true, data })
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    logger.error('Erro ao listar interfaces do cliente', { err })
    res.status(500).json({ error: 'Erro interno' })
  }
})

const interfacesSchema = z.object({
  interfaceIds: z.array(z.number().int().positive()),
})

/**
 * @swagger
 * /api/admin/institutions/{id}/interfaces:
 *   put:
 *     summary: Sincroniza o contrato comercial (concede a lista, revoga as demais)
 *     tags: [Admin]
 */
router.put('/institutions/:id/interfaces', async (req: Request, res: Response) => {
  const institutionId = parseInstitutionId(req, res)
  if (institutionId === null) return

  const parsed = interfacesSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido: esperado { interfaceIds: number[] }' })
    return
  }
  try {
    await updateInstitutionInterfaces(institutionId, parsed.data.interfaceIds)
    logger.info('Contrato de interfaces atualizado', { institutionId, total: parsed.data.interfaceIds.length })
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    logger.error('Erro ao atualizar interfaces do cliente', { err })
    res.status(500).json({ error: 'Erro interno' })
  }
})

const flagSchema = z.object({
  moduleKey: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/i),
  enabled:   z.boolean(),
})

/**
 * @swagger
 * /api/admin/institutions/{id}/feature-flags:
 *   put:
 *     summary: Gate técnico de módulo da API (mantido coerente com o contrato — decisão 17)
 *     tags: [Admin]
 */
router.put('/institutions/:id/feature-flags', async (req: Request, res: Response) => {
  const institutionId = parseInstitutionId(req, res)
  if (institutionId === null) return

  const parsed = flagSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido: esperado { moduleKey: string, enabled: boolean }' })
    return
  }
  try {
    await updateFeatureFlag(institutionId, parsed.data.moduleKey, parsed.data.enabled)
    logger.info('Feature flag atualizada', { institutionId, ...parsed.data })
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    logger.error('Erro ao atualizar feature flag', { err })
    res.status(500).json({ error: 'Erro interno' })
  }
})

export default router
