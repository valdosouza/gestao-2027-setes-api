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
 *       - in: query
 *         name: criteria
 *         schema: { type: string }
 *         description: 'Pesquisa avançada (D-BA1) — JSON { chave: valor } com as chaves de GET /search-criteria; texto = contém, faixa = { from, to }, lookup = id, options = [valores], bool = true|false. Soma em E com filter. Desconhecida/malformada = 400 SEARCH_CRITERIA_INVALID; valor inválido = 422 SEARCH_CRITERION_INVALID com fields[]'
 *     responses:
 *       200: { description: "{ ok, data, page, pageSize, total }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag desabilitada }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/services/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de serviços
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       declarada no módulo, sem expressão SQL.
 *     tags: [services]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind (text|number|money|date|lookup|options|bool), labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', controller.searchCriteria)

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
 * /api/services/price-lists:
 *   get:
 *     summary: Lookup de tabelas de preço vivas — grade do serviço NOVO (o app fala só com /api/services)
 *     tags: [services]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description }] }" }
 */
router.get('/price-lists', controller.priceListsLookup)

/**
 * @swagger
 * /api/services/tax-rules:
 *   get:
 *     summary: Lookup das regras de tributacao de servico vivas/ativas (FK literal do servico — D1)
 *     tags: [services]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description }] }" }
 */
router.get('/tax-rules', controller.taxRulesLookup)

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
 *               serviceTaxRuleId: { type: integer, nullable: true, description: Regra de tributacao de servico (FK literal D1) }
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
