import { Router } from 'express'
import * as controller from './order-returns.controller'

/**
 * Rotas da Devolução de Mercadoria (/api/order-returns — parecer
 * setes-conceito 2026-08-24). Tela de PROCESSO com shape de AÇÕES:
 * abrir a partir da venda faturada, ajustar quantidades, cancelar.
 * FATURAR é exclusivo do /api/billing/* (validate + invoice com
 * adjustment.{cfopId} — direction e pedido original DERIVADOS do
 * ramo/âncora). Flag técnica 'order-returns'.
 */
const router = Router()

/**
 * @swagger
 * /api/order-returns:
 *   get:
 *     summary: Lista devoluções de mercadoria (paginada)
 *     description: >-
 *       Ajustes de Entrada ANCORADOS num pedido de venda (existência da
 *       âncora tb_order_stock_adjust_return define a lista — ajustes
 *       avulsos ficam de fora por construção). status=A abertas, F
 *       faturadas; filter busca pelo nome do cliente.
 *     tags: [order-returns]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [A, F] }
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer }
 *       - in: query
 *         name: criteria
 *         schema: { type: string }
 *         description: 'Pesquisa avançada (D-BA1) — JSON { chave: valor } com as chaves de GET /search-criteria; texto = contém, faixa = { from, to }, lookup = id, options = [valores], bool = true|false. Soma em E com filter e com a aba (status). Desconhecida/malformada = 400 SEARCH_CRITERIA_INVALID; valor inválido = 422 SEARCH_CRITERION_INVALID com fields[]'
 *     responses:
 *       200: { description: "{ ok, data[], page, pageSize, total }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag order-returns desabilitada }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Abre uma devolução a partir de um pedido de venda FATURADO
 *     description: >-
 *       Cria backbone + ramo de ajuste (direction E) + ÂNCORA no pedido
 *       original + itens PRÉ-CARREGADOS (um por PRODUTO, quantidade =
 *       saldo devolvível agregado descontando devoluções consumadas E
 *       abertas; valor unitário do item mais recente da venda) — tudo em
 *       uma transação. Cliente e vendedor são DERIVADOS da origem.
 *     tags: [order-returns]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [saleOrderId]
 *             properties:
 *               saleOrderId: { type: integer, description: Pedido de venda faturado }
 *     responses:
 *       201: { description: "{ ok, data: { id } }" }
 *       400: { description: Payload inválido }
 *       404: { description: Pedido de venda não encontrado }
 *       422: { description: ORIGIN_NOT_INVOICED (venda sem nota) ou NOTHING_RETURNABLE (sem saldo) }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/order-returns/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada das devoluções
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md §13, Onda 3) — lista branca sem expressão SQL; a aba segue em status.
 *     tags: [order-returns]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', controller.searchCriteria)

/**
 * @swagger
 * /api/order-returns/customer-lookup:
 *   get:
 *     summary: Lookup de clientes do critério "cliente" (carteira do vendedor respeitada — D-BA34)
 *     description: >
 *       Lista de apoio { id, name } do painel da pesquisa avançada.
 *     tags: [order-returns]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome
 *     responses:
 *       200: { description: 'Envelope { ok, data }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/customer-lookup', controller.customerLookup)

/**
 * @swagger
 * /api/order-returns/cfop-lookup:
 *   get:
 *     summary: CFOPs do catálogo central para o faturamento da devolução (lista de apoio da tela)
 *     tags: [OrderReturns]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, description, active } (até 50)' }
 *       401: { description: Não autenticado }
 *       403: { description: Sem o privilégio VISUALIZAR da tela (ou tela não contratada) }
 */
// D-PV2: lista de apoio do PRÓPRIO módulo (antes a tela lia o /api de outra — a guarda por roteador exigiria o privilégio daquela tela) — o /api/cfop é do Super (superGuard): o admin recebia 403 nesse diálogo; declarada ANTES de GET /:id
router.get('/cfop-lookup', controller.cfopLookup)
router.post('/', controller.create)

/**
 * @swagger
 * /api/order-returns/{id}:
 *   get:
 *     summary: Detalhe da devolução (itens com teto devolvível por produto)
 *     description: >-
 *       Cabeçalho (pedido original, cliente, status) + itens com
 *       maxQuantity = saldo devolvível do produto EXCLUINDO esta
 *       devolução (teto de edição da tela; o gate real é o lock do
 *       faturamento).
 *     tags: [order-returns]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, data }" }
 *       404: { description: Devolução não encontrada }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Cancela devolução ABERTA
 *     description: Soft delete de âncora + ramo + backbone na mesma transação.
 *     tags: [order-returns]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "{ ok: true }" }
 *       404: { description: Devolução não encontrada }
 *       409: { description: Já faturada (ORDER_INVOICED) }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getOne)
router.delete('/:id', controller.remove)

/**
 * @swagger
 * /api/order-returns/{id}/items/{itemId}:
 *   put:
 *     summary: Ajusta a QUANTIDADE de um item da devolução aberta
 *     description: >-
 *       Único campo editável (produto/valor vêm da origem). 422
 *       RETURN_INVALID acima do saldo devolvível; 409 se já faturada.
 *     tags: [order-returns]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [quantity]
 *             properties:
 *               quantity: { type: number }
 *     responses:
 *       200: { description: "{ ok: true }" }
 *       404: { description: Item não encontrado }
 *       409: { description: Já faturada (ORDER_INVOICED) }
 *       422: { description: Quantidade acima do saldo (RETURN_INVALID) }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Remove item da devolução aberta (soft delete)
 *     description: >-
 *       Sem re-adicionar nesta versão — removeu por engano, cancela a
 *       devolução e reabre (pré-carga é automática).
 *     tags: [order-returns]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "{ ok: true }" }
 *       404: { description: Item não encontrado }
 *       409: { description: Já faturada (ORDER_INVOICED) }
 *       500: { description: Erro interno }
 */
router.put('/:id/items/:itemId', controller.updateItem)
router.delete('/:id/items/:itemId', controller.removeOrderItem)

export default router
