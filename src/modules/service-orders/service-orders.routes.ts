import { Router } from 'express'
import * as controller from './service-orders.controller'
import { requirePrivilege } from '@shared/auth/require-privilege'
import { PRIVILEGE_FATURAR } from '@shared/auth/privileges'

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
 *         description: Filtra pelo nome do cliente; só dígitos também acha pelo nº da OS ou da nota (igualdade)
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
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, number, customerId, customerName, status, dtRecord, itemsCount, totalValue, invoiceNumber, fiscalState (none|in_flight|authorized|rejected|failed|cancelled|cancel_in_flight; null = aberta ou nota da origem), fiscalEnvironment (H|P), nfseNumber }' }
 *       400: { description: 'criteria malformado ou com chave desconhecida' }
 *       401: { description: Não autenticado }
 *       422: { description: 'Valor inválido em critério (fields[])' }
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
 *     summary: SUGESTÃO de vencimento — o usuário decide (DP1)
 *     description: |
 *       Com `orderId`, o default é o dia do CONTRATO que alimentou a ordem
 *       (D12). Sem ele — ou quando os contratos da ordem divergem no dia —
 *       cai no 5º dia útil seg–sex do mês seguinte à competência.
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
 *       - in: query
 *         name: orderId
 *         required: false
 *         schema: { type: integer }
 *         description: Ordem sendo faturada — traz o dia do contrato dela (D12)
 *     responses:
 *       200: { description: 'Envelope { ok, data: { dtExpiration } }' }
 *       400: { description: Parâmetros inválidos }
 *       401: { description: Não autenticado }
 */
router.get('/expiration-suggestion', controller.suggestion)

/**
 * @swagger
 * /api/service-orders/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de OS
 *     description: Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2) — lista branca do módulo, sem expressão SQL.
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind, labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 */
router.get('/search-criteria', controller.searchCriteria)

/**
 * @swagger
 * /api/service-orders/customer-lookup:
 *   get:
 *     summary: Lista de apoio de clientes do critério "cliente" da pesquisa avançada
 *     tags: [ServiceOrders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, name } (até 50)' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/customer-lookup', controller.customerLookup)

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
 *     description: Ordem faturada não cancela por aqui (409) — a NOTA da OS cancela por POST /api/billing/cancel (Q-G3, 2026-09-09) e a OS volta a aberta.
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
// Q-G23 (Valdo 2026-09-09): FATURAR na interface do ramo (seed 53) — admin/super passam
router.post('/:id/invoice', requirePrivilege('service-orders', PRIVILEGE_FATURAR), controller.invoice)

/**
 * @swagger
 * /api/service-orders/batch-invoice:
 *   post:
 *     tags: [ServiceOrders]
 *     summary: Fatura em LOTE as ordens selecionadas (cobrança mensal)
 *     description: |
 *       D6/D7 da fase Primeiro Cliente (Valdo 2026-09-13): o operador
 *       SELECIONA as ordens na tela e o lote **segue e reporta** — cada ordem
 *       fatura na própria transação e a que falha sai no relatório com o
 *       motivo, sem derrubar as outras. Por isso a resposta é **200 mesmo com
 *       falhas parciais**: leia `failed` e `results[]`, nunca só o status.
 *       **Vencimento (D13)**: OMITA `dtExpiration` e cada ordem vence no dia do
 *       SEU contrato (`payment_day`, no mês seguinte à última competência
 *       injetada) — é o modo normal da cobrança mensal, porque o dia combinado
 *       é de cada cliente. Informar `dtExpiration` é OVERRIDE do operador e
 *       vale para o lote inteiro. Ordem sem contrato (OS avulsa) ou com
 *       contratos que divergem no dia é recusada com `ORDER_NO_CONTRACT_DUE_DAY`
 *       — o lote nunca inventa data. Forma e parcelas seguem valendo para todas;
 *       quem precisa de forma diferente faz dois lotes.
 *       **Rodada 5 (2026-09-19)**: D23 — as condições vêm do FATO da competência
 *       (congeladas na injeção), não do contrato vivo; D24 — `ok: true` e 200
 *       mesmo com `invoiced: 0` (a operação "tentar e relatar" executou); D25 —
 *       ordem recusada por contenção é reexecutada UMA vez ao final e, se ainda
 *       ocupada, volta com `retryable: true` (repetir é do operador); D26 — cada
 *       linha traz `chargedParcels/chargeableParcels` e `uncharged` conta a
 *       cobrança PARCIAL (`partiallyCharged` é o subconjunto); D27 — teto de
 *       **50** ordens por requisição (a tela fatia e agrega).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderIds]
 *             properties:
 *               orderIds: { type: array, items: { type: integer }, minItems: 1, maxItems: 50 }
 *               dtExpiration: { type: string, example: '2026-10-05', description: 'OPCIONAL (D13) — ausente = dia do contrato de cada ordem' }
 *               paymentTypeId: { type: integer, description: 'OPCIONAL (D14) — ausente = forma combinada no contrato de cada ordem' }
 *               parcels: { type: integer, enum: [1], default: 1, description: 'D30 — cobrança recorrente é sempre 1 parcela; outro valor → 400 (parcelamento só no faturamento individual)' }
 *     responses:
 *       200: { description: 'Envelope { ok, data: { requested, invoiced, failed, uncharged, partiallyCharged, retryable, results[] } } — cada linha traz dtExpiration/paymentTypeId REALMENTE usados, chargedParcels/chargeableParcels e retryable' }
 *       400: { description: Validação do lote }
 *       401: { description: Não autenticado }
 *       403: { description: Sem o privilégio FATURAR }
 */
router.post('/batch-invoice', requirePrivilege('service-orders', PRIVILEGE_FATURAR), controller.batchInvoice)

export default router
