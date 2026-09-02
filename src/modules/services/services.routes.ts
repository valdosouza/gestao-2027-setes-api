import { Router } from 'express'
import * as controller from './services.controller'

/**
 * Rotas do módulo services — /api/services (espelha /home/services no app;
 * NÃO confundir com service-orders, a OS do Software House). Cadastro do
 * CLIENTE; gate técnico = flag 'services'. Serviço = tb_product kind='S'
 * (natureza por ausência de especialização — D2 da fase de notas); grade
 * de preços tb_price por tabela viva (D4/D7). Liberação comercial só para
 * cliente sem legado (D3 — via tb_institution_has_interface).
 */
const router = Router()

/**
 * @swagger
 * /api/services:
 *   get:
 *     summary: Lista paginada de serviços (tb_product kind='S') da institution
 *     tags: [services]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: LIKE em description e identifier
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
 * /api/services/categories:
 *   get:
 *     summary: Lookup de categorias vivas da institution (form)
 *     tags: [services]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description }] }" }
 */
router.get('/categories', controller.categoriesLookup)

/**
 * @swagger
 * /api/services/financial-plans:
 *   get:
 *     summary: Lookup de planos financeiros vivos da institution (form)
 *     tags: [services]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description }] }" }
 */
router.get('/financial-plans', controller.financialPlansLookup)

/**
 * @swagger
 * /api/services/{id}:
 *   get:
 *     summary: Serviço por id, com a grade de preços (todas as tabelas vivas + preço atual)
 *     tags: [services]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok, data: ServiceFull (prices[]) }" }
 *       404: { description: Não encontrado (inclui id que é MERCADORIA — kind fora do módulo) }
 */
router.get('/:id', controller.getOne)

/**
 * @swagger
 * /api/services:
 *   post:
 *     summary: Cria serviço (kind='S' fixo; id MAX+1; identifier em branco vira o id — D1)
 *     tags: [services]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description, categoryId]
 *             properties:
 *               identifier:       { type: string, nullable: true, maxLength: 50 }
 *               description:      { type: string, maxLength: 100 }
 *               categoryId:       { type: integer }
 *               financialPlansId: { type: integer, nullable: true }
 *               promotion:        { type: string, enum: [S, N], default: N }
 *               highlights:       { type: string, enum: [S, N], default: N }
 *               published:        { type: string, enum: [S, N], default: N }
 *               active:           { type: string, enum: [S, N], default: S }
 *               note:             { type: string, nullable: true }
 *               prices:
 *                 type: array
 *                 description: Grade por tabela de preço (priceTag null remove)
 *                 items:
 *                   type: object
 *                   properties:
 *                     priceListId: { type: integer }
 *                     priceTag:    { type: number, nullable: true }
 *     responses:
 *       201: { description: "{ ok, data: { id } }" }
 *       400: { description: Validação/FK inexistente }
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/services/{id}:
 *   put:
 *     summary: Atualiza serviço + grade de preços (mesma transação; kind='S' no WHERE)
 *     tags: [services]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrado }
 *   delete:
 *     summary: Exclui (soft delete) — usos históricos permanecem
 *     tags: [services]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrado }
 */
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
