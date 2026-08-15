import { Router } from 'express'
import * as controller from './modules.controller'

/**
 * Rotas do módulo modules (MÓDULOS DE MENU do cliente) — montadas em
 * /api/modules pelo gateway com adminGuard (D2: personalizar o menu é ação
 * administrativa; escopo = schema do JWT).
 * Espelho no app: apps/web/lib/app/modules/modules/modules_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/modules:
 *   get:
 *     summary: Lista módulos de menu do institution (ordem do menu vertical)
 *     tags: [Modules]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por descrição
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *     responses:
 *       200: { description: 'Envelope paginado — data lista { id, description, position, imageIcon, interfaceIds[] (na ordem do menu) }' }
 *       401: { description: Não autenticado }
 *       403: { description: Acesso restrito a administradores }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/modules/interface-lookup:
 *   get:
 *     summary: Interfaces elegíveis ao vínculo (contratadas, kind T, fora do grupo Super)
 *     tags: [Modules]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: '{ ok, data: [{ id, description, i18nKey, groupDefault }] }' }
 */
router.get('/interface-lookup', controller.interfaceLookup)

/**
 * @swagger
 * /api/modules/{id}:
 *   get:
 *     summary: Retorna um módulo de menu com os vínculos na ordem
 *     tags: [Modules]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: '{ ok, data: { id, description, position, imageIcon, interfaceIds[] } }' }
 *       404: { description: Módulo não encontrado }
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/modules:
 *   post:
 *     summary: Cria módulo de menu (id MAX+1; a ORDEM do array interfaceIds é a ordem do menu — D3)
 *     tags: [Modules]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description]
 *             properties:
 *               description:  { type: string, example: 'Rotina Diária' }
 *               position:     { type: integer, nullable: true, description: 'Omitido = fim da fila' }
 *               imageIcon:    { type: string, nullable: true, example: 'point_of_sale', description: 'Nome de ícone Material (D4)' }
 *               interfaceIds: { type: array, items: { type: integer }, description: 'Na ordem desejada do menu' }
 *     responses:
 *       201: { description: '{ ok, data: { id } }' }
 *       422: { description: 'Interface não elegível (não contratada, kind R ou grupo Super) — fields[] traz os ids' }
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/modules/{id}:
 *   put:
 *     summary: Atualiza módulo e RESSINCRONIZA os vínculos na ordem do array (revoga o que saiu; upsert ressuscita)
 *     tags: [Modules]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: '{ ok: true }' }
 *       404: { description: Módulo não encontrado }
 *       422: { description: Interface não elegível }
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/modules/{id}:
 *   delete:
 *     summary: Exclui módulo de menu (graciosa — as telas voltam ao agrupamento por group_default)
 *     tags: [Modules]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: '{ ok: true }' }
 *       404: { description: Módulo não encontrado }
 */
router.delete('/:id', controller.remove)

export default router
