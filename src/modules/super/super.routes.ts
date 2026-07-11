import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { isSuper } from '@shared/auth/roles'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import {
  fetchCountries, fetchCountry, createCountry, editCountry, removeCountry,
  fetchStates,   fetchState,   createState,   editState,   removeState,
  fetchCities,   fetchCity,    createCity,    editCity,    removeCity,
  fetchInterfaces, fetchInterface, createInterface, editInterface, removeInterface,
  fetchPrivileges, fetchPrivilege, createPrivilege, editPrivilege, removePrivilege,
} from './super.service'

const router = Router()

// Guard: acesso restrito ao superusuário da Setes.
// Não há verificação de tb_institution_has_interface nem tb_user_has_privilege
// para o módulo Super — decisão registrada em 2026-07-09.
router.use((req: Request, res: Response, next) => {
  if (!isSuper(req.institution)) {
    res.status(403).json({ error: 'Acesso restrito à equipe Setes' })
    return
  }
  next()
})

function handleError(res: Response, err: unknown, ctx: string) {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message })
    return
  }
  logger.error(`Erro em ${ctx}`, { err })
  res.status(500).json({ error: 'Erro interno' })
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: 'id inválido' })
    return null
  }
  return id
}

// =====================================================================
// Country  — GET /api/super/countries[/:id]  POST  PUT /:id  DELETE /:id
// =====================================================================

// Código do país é padrão mundial (BACEN — ex.: Brasil 1058), informado pelo
// usuário na inclusão; NÃO é sequencial (decisão do Valdo, 2026-07-10).
const countryCreateBody = z.object({
  id:   z.number().int().positive(),
  name: z.string().min(1).max(100),
})

// PUT não altera o id — só o nome.
const countryUpdateBody = z.object({
  name: z.string().min(1).max(100),
})

/**
 * @swagger
 * /api/super/countries:
 *   get:
 *     summary: Lista países (filter?= busca por nome, máx. 200)
 *     tags: [Super]
 */
router.get('/countries', async (req: Request, res: Response) => {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchCountries(filter) })
  } catch (err) {
    handleError(res, err, 'super/countries GET')
  }
})

/**
 * @swagger
 * /api/super/countries/{id}:
 *   get:
 *     summary: Retorna um país pelo id
 *     tags: [Super]
 */
router.get('/countries/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCountry(id) })
  } catch (err) {
    handleError(res, err, 'super/countries/:id GET')
  }
})

/**
 * @swagger
 * /api/super/countries:
 *   post:
 *     summary: Cria um país (id = código mundial BACEN, informado pelo usuário; 409 se já existir)
 *     tags: [Super]
 */
router.post('/countries', async (req: Request, res: Response) => {
  const parsed = countryCreateBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const result = await createCountry(parsed.data.id, parsed.data.name)
    logger.info('País criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'super/countries POST')
  }
})

/**
 * @swagger
 * /api/super/countries/{id}:
 *   put:
 *     summary: Atualiza um país (somente o nome — o id/código nunca muda)
 *     tags: [Super]
 */
router.put('/countries/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  const parsed = countryUpdateBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await editCountry(id, parsed.data.name)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/countries/:id PUT')
  }
})

/**
 * @swagger
 * /api/super/countries/{id}:
 *   delete:
 *     summary: Exclui logicamente um país (deleted='S')
 *     tags: [Super]
 */
router.delete('/countries/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeCountry(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/countries/:id DELETE')
  }
})

// =====================================================================
// State  — GET /api/super/states[/:id]  POST  PUT /:id  DELETE /:id
// =====================================================================

// PUT não altera o id — só os demais campos.
const stateBody = z.object({
  tbCountryId:  z.number().int().nonnegative(),
  abbreviation: z.string().min(1).max(2),
  name:         z.string().min(1).max(100),
  aliquota:     z.number().nullable().optional(),
})

// Código do estado é o código IBGE da UF (ex.: Paraná 41, São Paulo 35),
// informado pelo usuário na inclusão; NÃO é sequencial (decisão do Valdo, 2026-07-11).
const stateCreateBody = stateBody.extend({
  id: z.number().int().positive(),
})

/**
 * @swagger
 * /api/super/states:
 *   get:
 *     summary: Lista estados (filter?= nome/UF; countryId?= filtro por país)
 *     tags: [Super]
 */
router.get('/states', async (req: Request, res: Response) => {
  try {
    const filter    = String(req.query.filter ?? '')
    const countryId = req.query.countryId ? Number(req.query.countryId) : undefined
    res.json({ ok: true, data: await fetchStates(filter, countryId) })
  } catch (err) {
    handleError(res, err, 'super/states GET')
  }
})

/**
 * @swagger
 * /api/super/states/{id}:
 *   get:
 *     summary: Retorna um estado pelo id
 *     tags: [Super]
 */
router.get('/states/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchState(id) })
  } catch (err) {
    handleError(res, err, 'super/states/:id GET')
  }
})

/**
 * @swagger
 * /api/super/states:
 *   post:
 *     summary: Cria um estado (id = código IBGE da UF, informado pelo usuário; 409 se já existir)
 *     tags: [Super]
 */
router.post('/states', async (req: Request, res: Response) => {
  const parsed = stateCreateBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const { id, ...input } = parsed.data
    const result = await createState(id, input)
    logger.info('Estado criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'super/states POST')
  }
})

/**
 * @swagger
 * /api/super/states/{id}:
 *   put:
 *     summary: Atualiza um estado
 *     tags: [Super]
 */
router.put('/states/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  const parsed = stateBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await editState(id, parsed.data)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/states/:id PUT')
  }
})

/**
 * @swagger
 * /api/super/states/{id}:
 *   delete:
 *     summary: Exclui logicamente um estado (deleted='S')
 *     tags: [Super]
 */
router.delete('/states/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeState(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/states/:id DELETE')
  }
})

// =====================================================================
// City  — GET /api/super/cities[/:id]  POST  PUT /:id  DELETE /:id
// =====================================================================

const cityBody = z.object({
  tbStateId:  z.number().int().nonnegative(),
  ibge:       z.string().max(20).nullable().optional(),
  name:       z.string().min(1).max(100),
  aliqIss:    z.number().min(0).optional(),
  population: z.number().int().min(0).optional(),
  density:    z.number().min(0).optional(),
  area:       z.number().min(0).optional(),
})

// Código da cidade é o código IBGE do município (ex.: Curitiba 4004),
// informado pelo usuário na inclusão; NÃO é sequencial (decisão do Valdo, 2026-07-11).
const cityCreateBody = cityBody.extend({
  id: z.number().int().positive(),
})

/**
 * @swagger
 * /api/super/cities:
 *   get:
 *     summary: Lista cidades (filter?= nome; stateId?= filtro por estado)
 *     tags: [Super]
 */
router.get('/cities', async (req: Request, res: Response) => {
  try {
    const filter  = String(req.query.filter ?? '')
    const stateId = req.query.stateId ? Number(req.query.stateId) : undefined
    res.json({ ok: true, data: await fetchCities(filter, stateId) })
  } catch (err) {
    handleError(res, err, 'super/cities GET')
  }
})

/**
 * @swagger
 * /api/super/cities/{id}:
 *   get:
 *     summary: Retorna uma cidade pelo id
 *     tags: [Super]
 */
router.get('/cities/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCity(id) })
  } catch (err) {
    handleError(res, err, 'super/cities/:id GET')
  }
})

/**
 * @swagger
 * /api/super/cities:
 *   post:
 *     summary: Cria uma cidade (id = código IBGE do município, informado pelo usuário; 409 se já existir)
 *     tags: [Super]
 */
router.post('/cities', async (req: Request, res: Response) => {
  const parsed = cityCreateBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const { id, ...input } = parsed.data
    const result = await createCity({ ...input, id })
    logger.info('Cidade criada', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'super/cities POST')
  }
})

/**
 * @swagger
 * /api/super/cities/{id}:
 *   put:
 *     summary: Atualiza uma cidade
 *     tags: [Super]
 */
router.put('/cities/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  const parsed = cityBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await editCity(id, parsed.data)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/cities/:id PUT')
  }
})

/**
 * @swagger
 * /api/super/cities/{id}:
 *   delete:
 *     summary: Exclui logicamente uma cidade (deleted='S')
 *     tags: [Super]
 */
router.delete('/cities/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeCity(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/cities/:id DELETE')
  }
})

// =====================================================================
// Interface  — GET /api/super/interfaces[/:id]  POST  PUT /:id  DELETE /:id
// Id gerado MAX+1 no backend (sem padrão externo — decisão do Valdo,
// 2026-07-11); kind e position são texto livre. privilegeIds sincroniza
// tb_interface_has_privilege. GET /api/core/menus (menu do app) NÃO é
// afetado por estas rotas.
// =====================================================================

const interfaceBody = z.object({
  groupDefault: z.string().max(100).nullable().optional(),
  i18nKey:      z.string().max(100).nullable().optional(),
  description:  z.string().min(1).max(100),
  kind:         z.string().max(26).nullable().optional(),
  position:     z.string().max(10).nullable().optional(),
  privilegeIds: z.array(z.number().int().positive()).optional(),
})

/**
 * @swagger
 * /api/super/interfaces:
 *   get:
 *     summary: Lista interfaces (filter?= description/i18n_key/group_default, máx. 200) com privilegeIds
 *     tags: [Super]
 */
router.get('/interfaces', async (req: Request, res: Response) => {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchInterfaces(filter) })
  } catch (err) {
    handleError(res, err, 'super/interfaces GET')
  }
})

/**
 * @swagger
 * /api/super/interfaces/{id}:
 *   get:
 *     summary: Retorna uma interface pelo id (com privilegeIds)
 *     tags: [Super]
 */
router.get('/interfaces/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchInterface(id) })
  } catch (err) {
    handleError(res, err, 'super/interfaces/:id GET')
  }
})

/**
 * @swagger
 * /api/super/interfaces:
 *   post:
 *     summary: Cria uma interface (id gerado MAX+1 no backend) e grava os privilégios
 *     tags: [Super]
 */
router.post('/interfaces', async (req: Request, res: Response) => {
  const parsed = interfaceBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const { privilegeIds, ...input } = parsed.data
    const result = await createInterface(input, privilegeIds ?? [])
    logger.info('Interface criada', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'super/interfaces POST')
  }
})

/**
 * @swagger
 * /api/super/interfaces/{id}:
 *   put:
 *     summary: Atualiza uma interface (o id nunca muda) e sincroniza os privilégios
 *     tags: [Super]
 */
router.put('/interfaces/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  const parsed = interfaceBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const { privilegeIds, ...input } = parsed.data
    await editInterface(id, input, privilegeIds ?? [])
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/interfaces/:id PUT')
  }
})

/**
 * @swagger
 * /api/super/interfaces/{id}:
 *   delete:
 *     summary: Exclui logicamente uma interface (deleted='S')
 *     tags: [Super]
 */
router.delete('/interfaces/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeInterface(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/interfaces/:id DELETE')
  }
})

// =====================================================================
// Privilege  — GET /api/super/privileges[/:id]  POST  PUT /:id  DELETE /:id
// Id gerado MAX+1 no backend (sem padrão externo — mesma decisão do
// cadastro de Interfaces, Valdo 2026-07-11). A lista também alimenta os
// checkboxes da tela de Interfaces (tb_interface_has_privilege).
// =====================================================================

// PUT não altera o id — só a description (varchar(100) na tb_privilege).
const privilegeBody = z.object({
  description: z.string().min(1).max(100),
})

/**
 * @swagger
 * /api/super/privileges:
 *   get:
 *     summary: Lista privilégios (filter?= description) — cadastro e checkboxes da tela de Interfaces
 *     tags: [Super]
 */
router.get('/privileges', async (req: Request, res: Response) => {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchPrivileges(filter) })
  } catch (err) {
    handleError(res, err, 'super/privileges GET')
  }
})

/**
 * @swagger
 * /api/super/privileges/{id}:
 *   get:
 *     summary: Retorna um privilégio pelo id (404 se não existir ou excluído)
 *     tags: [Super]
 */
router.get('/privileges/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchPrivilege(id) })
  } catch (err) {
    handleError(res, err, 'super/privileges/:id GET')
  }
})

/**
 * @swagger
 * /api/super/privileges:
 *   post:
 *     summary: Cria um privilégio (id gerado MAX+1 no backend)
 *     tags: [Super]
 */
router.post('/privileges', async (req: Request, res: Response) => {
  const parsed = privilegeBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const result = await createPrivilege(parsed.data.description)
    logger.info('Privilégio criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'super/privileges POST')
  }
})

/**
 * @swagger
 * /api/super/privileges/{id}:
 *   put:
 *     summary: Atualiza um privilégio (somente a description — o id nunca muda)
 *     tags: [Super]
 */
router.put('/privileges/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  const parsed = privilegeBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await editPrivilege(id, parsed.data.description)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/privileges/:id PUT')
  }
})

/**
 * @swagger
 * /api/super/privileges/{id}:
 *   delete:
 *     summary: Exclui logicamente um privilégio (deleted='S')
 *     tags: [Super]
 */
router.delete('/privileges/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removePrivilege(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'super/privileges/:id DELETE')
  }
})

export default router
