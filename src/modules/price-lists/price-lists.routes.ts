import { Router } from 'express'
import * as controller from './price-lists.controller'

/**
 * Rotas do módulo price-lists — /api/price-lists (espelha /home/price_lists
 * no app). Cadastro do CLIENTE (schema + institution do JWT); gate técnico
 * = flag 'price-lists'. Tabelas de Preço alimentam a grade de preços do
 * cadastro de serviço (D7 do prompt_modulo_services.md) e do futuro
 * cadastro de produtos (telas irmãs — D6).
 */
const router = Router()

/**
 * @swagger
 * /api/price-lists:
 *   get:
 *     summary: Lista paginada de tabelas de preço da institution
 *     tags: [price-lists]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok, data, page, pageSize, total }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag desabilitada }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/price-lists/{id}:
 *   get:
 *     summary: Tabela de preço por id (escopo da institution)
 *     tags: [price-lists]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok, data: { id, description, validity, modality, published } }" }
 *       404: { description: Não encontrada }
 */
router.get('/:id', controller.getOne)

/**
 * @swagger
 * /api/price-lists:
 *   post:
 *     summary: Cria tabela de preço (id MAX+1 por institution)
 *     tags: [price-lists]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description]
 *             properties:
 *               description: { type: string, maxLength: 45 }
 *               validity:    { type: string, nullable: true, example: '2027-12-31' }
 *               modality:    { type: string, nullable: true, maxLength: 1 }
 *               published:   { type: string, enum: [S, N], default: S }
 *     responses:
 *       201: { description: "{ ok, data: { id } }" }
 *       400: { description: Validação falhou }
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/price-lists/{id}:
 *   put:
 *     summary: Atualiza tabela de preço
 *     tags: [price-lists]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrada }
 *   delete:
 *     summary: Exclui (soft delete) — preços gravados ficam como histórico
 *     tags: [price-lists]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrada }
 */
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
