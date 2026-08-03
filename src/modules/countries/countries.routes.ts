import { Router } from 'express'
import * as controller from './countries.controller'

/**
 * Rotas do módulo countries — montadas em /api/countries pelo gateway
 * (superGuard por módulo; "Super" é só agrupador de menu, nunca código/URL).
 * Espelho no app: apps/web/lib/app/modules/countries/countries_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/countries:
 *   get:
 *     summary: Lista países da base central
 *     tags: [Countries]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, name }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/countries/{id}:
 *   get:
 *     summary: Retorna um país pelo id
 *     tags: [Countries]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/countries:
 *   post:
 *     summary: Cria um país (id = código mundial BACEN, informado pelo usuário; 409 se já existir)
 *     tags: [Countries]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/countries/{id}:
 *   put:
 *     summary: Atualiza um país (somente o nome — o id/código nunca muda)
 *     tags: [Countries]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/countries/{id}:
 *   delete:
 *     summary: Exclui logicamente um país (deleted='S')
 *     tags: [Countries]
 */
router.delete('/:id', controller.remove)

export default router
