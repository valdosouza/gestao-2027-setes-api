import { Router } from 'express'
import * as controller from './states.controller'

/**
 * Rotas do módulo states — montadas em /api/states pelo gateway.
 * Espelho no app: apps/web/lib/app/modules/states/states_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/states:
 *   get:
 *     summary: Lista estados da base central
 *     tags: [States]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome ou UF (abbreviation)
 *       - in: query
 *         name: countryId
 *         schema: { type: integer }
 *         description: Filtro por país
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, tbCountryId, abbreviation, name, aliquota, countryName }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/states/{id}:
 *   get:
 *     summary: Retorna um estado pelo id
 *     tags: [States]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/states:
 *   post:
 *     summary: Cria um estado (id = código IBGE da UF, informado pelo usuário; 409 se já existir)
 *     tags: [States]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/states/{id}:
 *   put:
 *     summary: Atualiza um estado
 *     tags: [States]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/states/{id}:
 *   delete:
 *     summary: Exclui logicamente um estado (deleted='S')
 *     tags: [States]
 */
router.delete('/:id', controller.remove)

export default router
