import { Router } from 'express'
import * as controller from './orders.controller'

/**
 * Rotas do módulo orders — montadas em /api/orders. TELA DE PROCESSO
 * (grupo Vendas; sem superGuard — escopo por institution do JWT); gate
 * técnico = flag 'orders'. Faturamento NÃO é ação deste módulo — a tela
 * chama /api/billing/validate + /api/billing/invoice.
 * Espelho no app: apps/web/lib/app/modules/orders/.
 */
const router = Router()

/**
 * @swagger
 * /api/orders:
 *   get:
 *     summary: Lista os pedidos de venda da institution (filtro por status e cliente)
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [A, F] }
 *         description: A = abertos, F = faturados (omitido = todos)
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
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, number, customerId, customerName, salesmanId, salesmanName, status, dtRecord, hasService, itemsCount, totalValue }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/orders:
 *   post:
 *     summary: Abre um pedido de venda (cliente + vendedor)
 *     description: >-
 *       Vendedor é SEMPRE escolha explícita ou default da carteira do
 *       cliente (tb_customer.tb_salesman_id) — 400 SALESMAN_REQUIRED se
 *       nenhum dos dois existir. Conjugada (mercadoria+serviço) nasce
 *       depois, por PRESENÇA, ao incluir o 1º item de serviço.
 *     tags: [Orders]
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
 *               salesmanId: { type: integer, nullable: true }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: 'Cliente inexistente (ROLE_MISSING) ou sem vendedor (SALESMAN_REQUIRED)' }
 *       401: { description: Não autenticado }
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/orders/merchandise-lookup:
 *   get:
 *     summary: Lookup de mercadorias ativas (tb_product.kind IN P,M) pro seletor de itens
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data: [{ id, description, kind }] }' }
 *       401: { description: Não autenticado }
 */
router.get('/merchandise-lookup', controller.merchandiseLookup)

/**
 * @swagger
 * /api/orders/service-lookup:
 *   get:
 *     summary: Lookup de serviços ativos (tb_product.kind = S) pro seletor de itens
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data: [{ id, description, kind }] }' }
 *       401: { description: Não autenticado }
 */
router.get('/service-lookup', controller.serviceLookup)

/**
 * @swagger
 * /api/orders/{id}:
 *   get:
 *     summary: Detalhe do pedido (cabeçalho + itens + total)
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data: OrderFull }' }
 *       401: { description: Não autenticado }
 *       404: { description: Pedido não encontrado }
 */
router.get('/:id', controller.getOne)

/**
 * @swagger
 * /api/orders/{id}:
 *   delete:
 *     summary: Cancela o pedido ABERTO (soft delete)
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok: true }' }
 *       401: { description: Não autenticado }
 *       404: { description: Pedido não encontrado }
 *       409: { description: 'Pedido já faturado (ORDER_INVOICED)' }
 */
router.delete('/:id', controller.remove)

/**
 * @swagger
 * /api/orders/{id}/items:
 *   post:
 *     summary: Inclui item — a natureza do produto decide o ramo (mercadoria = Sale, serviço = Service)
 *     description: >-
 *       Item de serviço cria automaticamente o ramo tb_order_service
 *       (conjugada, por PRESENÇA) se ainda não existir. Preço é sempre
 *       DIGITADO (mesmo padrão de service-orders — sem tabela de preço
 *       automática nesta rodada).
 *     tags: [Orders]
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
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: Produto inexistente }
 *       401: { description: Não autenticado }
 *       404: { description: Pedido não encontrado }
 *       409: { description: 'Pedido já faturado (ORDER_INVOICED)' }
 */
router.post('/:id/items', controller.addOrderItem)

/**
 * @swagger
 * /api/orders/{id}/items/{itemId}:
 *   put:
 *     summary: Edita item (quantidade/valor/desconto/produto)
 *     tags: [Orders]
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
 *             required: [productId, unitValue]
 *             properties:
 *               productId: { type: integer }
 *               quantity: { type: number, default: 1 }
 *               unitValue: { type: number }
 *               discountValue: { type: number, nullable: true }
 *     responses:
 *       200: { description: 'Envelope { ok: true }' }
 *       401: { description: Não autenticado }
 *       404: { description: Item não encontrado }
 *       409: { description: 'Pedido já faturado (ORDER_INVOICED)' }
 */
router.put('/:id/items/:itemId', controller.updateOrderItem)

/**
 * @swagger
 * /api/orders/{id}/items/{itemId}:
 *   delete:
 *     summary: Remove item (soft delete)
 *     tags: [Orders]
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
 *       200: { description: 'Envelope { ok: true }' }
 *       401: { description: Não autenticado }
 *       404: { description: Item não encontrado }
 *       409: { description: 'Pedido já faturado (ORDER_INVOICED)' }
 */
router.delete('/:id/items/:itemId', controller.removeOrderItem)

export default router
