import { Router } from 'express'
import * as controller from './privileges.controller'

/**
 * Rotas do módulo privileges — montadas em /api/privileges pelo
 * gateway. A lista também alimenta os checkboxes da tela de Interfaces.
 * Espelho no app: apps/web/lib/app/modules/privileges/privileges_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/privileges:
 *   get:
 *     summary: Lista privilégios — cadastro e checkboxes da tela de Interfaces
 *     tags: [Privileges]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por description
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, description }' }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito à equipe Setes }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/privileges/{id}:
 *   get:
 *     summary: Retorna um privilégio pelo id (404 se não existir ou excluído)
 *     tags: [Privileges]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/privileges:
 *   post:
 *     summary: Cria um privilégio (id gerado MAX+1 no backend)
 *     tags: [Privileges]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/privileges/{id}:
 *   put:
 *     summary: Atualiza um privilégio (somente a description — o id nunca muda)
 *     tags: [Privileges]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/privileges/{id}:
 *   delete:
 *     summary: Exclui logicamente um privilégio (deleted='S')
 *     tags: [Privileges]
 */
router.delete('/:id', controller.remove)

export default router
