import { Router } from 'express'
import * as controller from './cities.controller'

/**
 * Rotas do módulo cities — montadas em /api/cities pelo gateway.
 * Espelho no app: apps/web/lib/app/modules/cities/cities_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/cities:
 *   get:
 *     summary: Lista cidades da base central
 *     tags: [Cities]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome
 *       - in: query
 *         name: stateId
 *         schema: { type: integer }
 *         description: Filtro por estado
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, tbStateId, ibge, name, aliqIss, population, density, area, stateName }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/cities/{id}:
 *   get:
 *     summary: Retorna uma cidade pelo id
 *     tags: [Cities]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/cities:
 *   post:
 *     summary: Cria uma cidade (id = código IBGE do município, informado pelo usuário; 409 se já existir)
 *     tags: [Cities]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/cities/{id}:
 *   put:
 *     summary: Atualiza uma cidade
 *     tags: [Cities]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/cities/{id}:
 *   delete:
 *     summary: Exclui logicamente uma cidade (deleted='S')
 *     tags: [Cities]
 */
router.delete('/:id', controller.remove)

export default router
