import { Router } from 'express'
import * as controller from './service-orders.controller'

/**
 * Rotas do módulo service-orders — montadas em /api/service-orders.
 * 1ª TELA DE PROCESSO (grupo Serviços; sem superGuard — escopo por
 * institution do JWT); gate técnico = flag 'service-orders'.
 * Espelho no app: apps/web/lib/app/modules/service_orders/.
 */
const router = Router()

/**
 * @swagger
 * /api/service-orders:
 *   get:
 *     summary: Lista as ordens de serviço da institution (filtro por status e cliente)
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [A, F] }
 *         description: A = abertas, F = faturadas (omitido = todas)
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra pelo nome do cliente
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, number, customerId, customerName, status, dtRecord, itemsCount, totalValue }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Abre uma OS manual para o cliente (trava D5 — máx. 1 aberta)
 *     description: >
 *       Cria tb_order (status 'A' — DP7) + tb_order_service com open_lock
 *       preenchido pela aplicação; a UNIQUE é a rede da corrida. Cliente
 *       com ordem aberta = 409.
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customerId]
 *             properties:
 *               customerId: { type: integer }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: 'Validação / cliente inexistente' }
 *       401: { description: Não autenticado }
 *       409: { description: 'Cliente já tem ordem aberta (D5)' }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/service-orders/monthly-run:
 *   post:
 *     summary: Rotina de faturamento mensal (botão manual — D8)
 *     description: >
 *       Para cada cliente com contrato VIGENTE na competência — transação
 *       POR CLIENTE: reusa a ordem aberta (ou abre nova) e injeta os itens
 *       do contrato com pró-rata 30 dias corridos (D2 cliente novo / D3
 *       cancelado parcial). Idempotente: item do produto já injetado na
 *       competência não duplica. Devolve o relatório da execução.
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [year, month]
 *             properties:
 *               year: { type: integer, example: 2026 }
 *               month: { type: integer, minimum: 1, maximum: 12 }
 *     responses:
 *       200: { description: 'Envelope { ok, data: { processed, opened, injected, skipped, errors[] } }' }
 *       400: { description: Validação }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.post('/monthly-run', controller.monthly)

/**
 * @swagger
 * /api/service-orders/expiration-suggestion:
 *   get:
 *     summary: SUGESTÃO de vencimento (5º dia útil seg–sex do mês seguinte) — o usuário decide (DP1)
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data: { dtExpiration } }' }
 *       400: { description: Parâmetros inválidos }
 *       401: { description: Não autenticado }
 */
router.get('/expiration-suggestion', controller.suggestion)

/**
 * @swagger
 * /api/service-orders/products:
 *   get:
 *     summary: Lookup de produtos/serviços ATIVOS (itens avulsos — tarefas 4.4)
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, description }' }
 *       401: { description: Não autenticado }
 */
router.get('/products', controller.productsLookup)

/**
 * @swagger
 * /api/service-orders/{id}:
 *   get:
 *     summary: Retorna a OS completa (itens + totalizer + fatura quando houver)
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — { id, number, customerId, customerName, status, dtRecord, items[], totalValue, invoiceNumber, dtEmission }' }
 *       401: { description: Não autenticado }
 *       404: { description: OS não encontrada }
 *   delete:
 *     summary: Cancela a OS ABERTA (soft delete — libera a trava D5)
 *     description: Ordem faturada não cancela (409) — o caminho é o estorno financeiro.
 *     tags: [ServiceOrders]
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
 *       404: { description: OS não encontrada }
 *       409: { description: Ordem já faturada }
 */
router.get('/:id', controller.getOne)
router.delete('/:id', controller.remove)

/**
 * @swagger
 * /api/service-orders/{id}/items:
 *   post:
 *     summary: Inclui item de serviço na OS aberta (tarefa avulsa — valor fechado D4)
 *     tags: [ServiceOrders]
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
 *             required: [productId, unitValue]
 *             properties:
 *               productId: { type: integer }
 *               quantity: { type: number, default: 1 }
 *               unitValue: { type: number }
 *               discountValue: { type: number, nullable: true }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } } — totalizer recalculado' }
 *       400: { description: 'Validação / produto inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: OS não encontrada }
 *       409: { description: Ordem já faturada }
 */
router.post('/:id/items', controller.addOrderItem)

/**
 * @swagger
 * /api/service-orders/{id}/items/{itemId}:
 *   put:
 *     summary: Altera um item da OS aberta (totalizer recalculado)
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               productId: { type: integer }
 *               quantity: { type: number }
 *               unitValue: { type: number }
 *               discountValue: { type: number, nullable: true }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       401: { description: Não autenticado }
 *       404: { description: OS/item não encontrado }
 *       409: { description: Ordem já faturada }
 *   delete:
 *     summary: Remove um item da OS aberta (soft delete; totalizer recalculado)
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       401: { description: Não autenticado }
 *       404: { description: OS/item não encontrado }
 *       409: { description: Ordem já faturada }
 */
router.put('/:id/items/:itemId', controller.updateOrderItem)
router.delete('/:id/items/:itemId', controller.removeOrderItem)

/**
 * @swagger
 * /api/service-orders/{id}/invoice:
 *   post:
 *     summary: "Gerar Faturamento: billing → fatura interna 'SE' → financeiro RA → ordem A→F"
 *     description: >
 *       Transação única (4.5.6/Fase 6): recalcula o totalizer, grava as
 *       condições de cobrança (tb_order_billing), emite a fatura INTERNA
 *       (tb_invoice model 'SE', número MAX+1 — emissão oficial NFS-e é
 *       futura/P1), gera tb_financial + tb_financial_bills kind 'RA' por
 *       parcela (resíduo de centavos na última) com o VENCIMENTO DECIDIDO
 *       PELO USUÁRIO (DP1 — GET /expiration-suggestion dá só o default) e
 *       fecha a ordem (status 'F' na tb_order; open_lock esvazia — D5).
 *     tags: [ServiceOrders]
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
 *             required: [dtExpiration, paymentTypeId]
 *             properties:
 *               dtExpiration: { type: string, example: '2026-08-07', description: 'Vencimento DECIDIDO PELO USUÁRIO (DP1)' }
 *               paymentTypeId: { type: integer, description: 'Forma vinculada e habilitada na institution' }
 *               parcels: { type: integer, default: 1, minimum: 1, maximum: 99 }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { invoiceNumber, parcels, totalValue } }' }
 *       400: { description: 'Validação / forma indisponível / ordem sem itens' }
 *       401: { description: Não autenticado }
 *       404: { description: OS não encontrada }
 *       409: { description: Ordem já faturada }
 */
router.post('/:id/invoice', controller.invoice)

export default router
