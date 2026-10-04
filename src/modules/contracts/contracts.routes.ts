import { Router } from 'express'
import * as controller from './contracts.controller'

/**
 * Rotas do módulo contracts — montadas em /api/contracts.
 * Cadastro de CLIENTE, grupo Cadastros (sem superGuard — escopo por
 * institution do JWT); gate técnico = flag 'contracts'.
 * Espelho no app: apps/web/lib/app/modules/contracts/.
 */
const router = Router()

/**
 * @swagger
 * /api/contracts:
 *   get:
 *     summary: Lista os contratos de serviço da institution do usuário
 *     tags: [Contracts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra pelo nome do cliente
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *       - in: query
 *         name: criteria
 *         schema: { type: string }
 *         description: 'Pesquisa avançada (D-BA1) — JSON { chave: valor } com as chaves de GET /search-criteria; texto = contém, faixa = { from, to }, lookup = id, options = [valores], bool = true|false. Soma em E com filter. Desconhecida/malformada = 400 SEARCH_CRITERIA_INVALID; valor inválido = 422 SEARCH_CRITERION_INVALID com fields[]'
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, customerId, customerName, dtStart, dtEnd, monthlyValue (SUM dos itens — DP3), active }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Cria um contrato com seus itens (transação única)
 *     description: >
 *       Módulo Software House (prompt fechado). id MAX+1 por institution;
 *       cliente validado no papel local (tb_customer) dentro da transação;
 *       N produtos (D9) com valor mensal por item — a mensalidade do
 *       contrato é a SOMA dos itens (DP3, sem campo redundante).
 *       payment_day é informativo (o vencimento do faturamento é decidido
 *       pelo usuário na tela — DP1).
 *     tags: [Contracts]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customerId, dtStart, items]
 *             properties:
 *               customerId: { type: integer }
 *               dtStart: { type: string, example: '2026-07-01' }
 *               dtEnd: { type: string, nullable: true }
 *               paymentDay: { type: integer, description: 'Dia de vencimento informativo (1–28, default 5)' }
 *               active: { type: string, enum: [S, N] }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [productId, value]
 *                   properties:
 *                     productId: { type: integer }
 *                     value: { type: number, description: 'Valor MENSAL do produto no contrato' }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: 'Validação / cliente inexistente na institution' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/contracts/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de contratos
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       declarada no módulo, sem expressão SQL.
 *     tags: [Contracts]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind, labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', controller.searchCriteria)

/**
 * @swagger
 * /api/contracts/customer-lookup:
 *   get:
 *     summary: Lookup de clientes do critério "cliente" (carteira do vendedor respeitada — D-BA27)
 *     tags: [Contracts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome/apelido
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, name }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/customer-lookup', controller.customerLookup)

/**
 * @swagger
 * /api/contracts/payment-types:
 *   get:
 *     summary: Lookup de formas de pagamento habilitadas (critério "forma" do contrato)
 *     tags: [Contracts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por descrição
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, name }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/payment-types', controller.paymentTypesLookup)
router.post('/', controller.create)

/**
 * @swagger
 * /api/contracts/products:
 *   get:
 *     summary: Lookup de produtos/serviços ATIVOS da institution (itens do contrato)
 *     tags: [Contracts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por descrição
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, description }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/products', controller.productsLookup)

/**
 * @swagger
 * /api/contracts/{id}:
 *   get:
 *     summary: Retorna o contrato completo (com itens) pelo id
 *     tags: [Contracts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — { id, customerId, customerName, dtStart, dtEnd, paymentDay, active, items[{ productId, productDescription, value }] }' }
 *       401: { description: Não autenticado }
 *       404: { description: Contrato não encontrado }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualiza o contrato e SINCRONIZA os itens (soft delete dos ausentes + upsert)
 *     tags: [Contracts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customerId, dtStart, items]
 *             properties:
 *               customerId: { type: integer }
 *               dtStart: { type: string }
 *               dtEnd: { type: string, nullable: true }
 *               paymentDay: { type: integer }
 *               active: { type: string, enum: [S, N] }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     productId: { type: integer }
 *                     value: { type: number }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: 'Validação / cliente inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: Contrato não encontrado }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Exclui o contrato (soft delete)
 *     tags: [Contracts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       401: { description: Não autenticado }
 *       404: { description: Contrato não encontrado }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getOne)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
