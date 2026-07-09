import { Router, Request, Response } from 'express'
import { z } from 'zod'
import {
  getInstitutionData, getSessionInfo,
  getUserPreferences, setUserPreference,
  getInstitutionTheme, setInstitutionTheme,
  getMenus,
} from './core.service'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

function handleError(res: Response, err: unknown, context: string) {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message })
    return
  }
  logger.error(`Erro em ${context}`, { err })
  res.status(500).json({ error: 'Erro interno' })
}

router.get('/info', async (req: Request, res: Response) => {
  try {
    const data = await getInstitutionData(req.institution!.schemaName)
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'core/info')
  }
})

/**
 * @swagger
 * /api/core/me:
 *   get:
 *     summary: Identificação do usuário logado (nome, papel, institution)
 *     tags: [Core]
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const data = await getSessionInfo(req.institution!)
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'core/me GET')
  }
})

// ---------------------------------------------------------------------
// Preferências do usuário (setes-app Fase 1, decisão 14)
// ---------------------------------------------------------------------

/**
 * @swagger
 * /api/core/preferences:
 *   get:
 *     summary: Preferências do usuário autenticado (ex. locale)
 *     tags: [Core]
 */
router.get('/preferences', async (req: Request, res: Response) => {
  try {
    const data = await getUserPreferences(req.institution!.userId)
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'core/preferences GET')
  }
})

const preferenceSchema = z.object({
  key:   z.string().min(1).max(50).regex(/^[a-z0-9_.-]+$/i, 'key deve ser alfanumérica'),
  value: z.string().max(255),
})

/**
 * @swagger
 * /api/core/preferences:
 *   put:
 *     summary: Grava uma preferência do usuário (upsert por chave)
 *     tags: [Core]
 */
router.put('/preferences', async (req: Request, res: Response) => {
  const parsed = preferenceSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await setUserPreference(req.institution!.userId, parsed.data.key, parsed.data.value)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'core/preferences PUT')
  }
})

// ---------------------------------------------------------------------
// Tema por institution (setes-app Fase 1, decisão 16)
// ---------------------------------------------------------------------

/**
 * @swagger
 * /api/core/theme:
 *   get:
 *     summary: Tema/logomarca da institution do JWT (carregado após o login)
 *     tags: [Core]
 */
router.get('/theme', async (req: Request, res: Response) => {
  try {
    const data = await getInstitutionTheme(req.institution!.institutionId)
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'core/theme GET')
  }
})

const COLOR_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/
const themeSchema = z.object({
  primaryColor:   z.string().regex(COLOR_RE, 'cor em #RRGGBB ou #RRGGBBAA').optional(),
  secondaryColor: z.string().regex(COLOR_RE, 'cor em #RRGGBB ou #RRGGBBAA').optional(),
  logoBase64:     z.string().max(2_100_000).optional(), // data URI
})

/**
 * @swagger
 * /api/core/theme:
 *   put:
 *     summary: Atualiza tema/logomarca da institution (o próprio cliente edita)
 *     tags: [Core]
 */
router.put('/theme', async (req: Request, res: Response) => {
  const parsed = themeSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await setInstitutionTheme(req.institution!.institutionId, parsed.data)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'core/theme PUT')
  }
})

// ---------------------------------------------------------------------
// Menus dinâmicos (setes-app Fase 1, decisões 18 e 21)
// ---------------------------------------------------------------------

/**
 * @swagger
 * /api/core/menus:
 *   get:
 *     summary: Árvore módulos → interfaces → privilégios, filtrada pelo usuário
 *     tags: [Core]
 */
router.get('/menus', async (req: Request, res: Response) => {
  try {
    const data = await getMenus(req.institution!)
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'core/menus GET')
  }
})

export default router
