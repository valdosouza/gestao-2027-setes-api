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
 * /api/orders/payment-types-lookup:
 *   get:
 *     summary: Lookup das formas de pagamento vinculadas/habilitadas (negociação — cabeçalho e forma por parcela)
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data: [{ id, description, kind, maxParcels }] }' }
 *       401: { description: Não autenticado }
 */
router.get('/payment-types-lookup', controller.paymentTypesLookup)

/**
 * @swagger
 * /api/orders/banks-lookup:
 *   get:
 *     summary: Lookup dos bancos do catálogo central (cheques do faturamento — mesmo shape de /api/checks/banks)
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data: [{ id, number, description }] }' }
 *       401: { description: Não autenticado }
 */
router.get('/banks-lookup', controller.banksLookup)

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

/**
 * @swagger
 * /api/orders/{id}/negotiation:
 *   get:
 *     summary: Negociação do pedido — prazo (via simples) × parcelamento elaborado
 *     description: >
 *       Cabeçalho = tb_order_billing (forma + prazo string '028/056/084'); grade =
 *       tb_order_installment (presença = elaborado — decisão 25). `preview` = parcelas
 *       GERADAS do prazo sobre a base do PEDIDO (itens + frete, sem impostos), nunca
 *       gravadas; `mode` é derivado. `paymentTypeKind` 'Q' = a parcela exigirá cheques
 *       no faturamento (bloco `checks` do POST /api/billing/invoice).
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data: { orderId, status, mode, billing, base, installments[], preview[] } }' }
 *       401: { description: Não autenticado }
 *       404: { description: 'Pedido não encontrado (ORDER_NOT_FOUND)' }
 *   put:
 *     summary: Grava a negociação (transação única) e devolve a negociação recomposta
 *     description: >
 *       `installments` presente e não vazio = via ELABORADA (substitui a grade; parcelas
 *       1..n contíguas; soma = base do PEDIDO — 422 INSTALLMENT_MISMATCH; forma por parcela
 *       opcional, NULL herda a do cabeçalho); ausente/vazio = "voltar ao prazo". Prazo é
 *       normalizado para '028/056/084' (lixo → 422 INVALID_DEADLINE). Formas precisam
 *       estar vinculadas/habilitadas (400 PAYMENT_TYPE_UNAVAILABLE) e o nº de parcelas
 *       respeita max_parcels do vínculo (422 MAX_PARCELS_EXCEEDED).
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
 *             required: [paymentTypeId]
 *             properties:
 *               paymentTypeId: { type: integer }
 *               deadline: { type: string, nullable: true, example: '028/056/084' }
 *               installments:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [parcel, dueDate, amount]
 *                   properties:
 *                     parcel: { type: integer }
 *                     dueDate: { type: string, example: '2026-10-05' }
 *                     amount: { type: number }
 *                     paymentTypeId: { type: integer, nullable: true }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — mesma forma do GET' }
 *       400: { description: 'Validação / forma indisponível (PAYMENT_TYPE_UNAVAILABLE)' }
 *       401: { description: Não autenticado }
 *       404: { description: 'Pedido não encontrado (ORDER_NOT_FOUND)' }
 *       409: { description: 'Pedido já faturado (ORDER_INVOICED)' }
 *       422: { description: 'INVALID_DEADLINE | INSTALLMENT_INVALID | INSTALLMENT_MISMATCH | MAX_PARCELS_EXCEEDED' }
 */
router.get('/:id/negotiation', controller.getNegotiation)
router.put('/:id/negotiation', controller.putNegotiation)

export default router
