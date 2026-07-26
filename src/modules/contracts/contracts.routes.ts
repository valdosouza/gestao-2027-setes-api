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
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, customerId, customerName, dtStart, dtEnd, monthlyValue (SUM dos itens — DP3), active }' }
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
