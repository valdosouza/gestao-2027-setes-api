import { Router } from 'express'
import * as controller from './checks.controller'

/**
 * Rotas do módulo checks — montadas em /api/checks (tela de PROCESSO,
 * grupo Financeiro; flag 'checks'). Cheque = título ao PORTADOR; estado
 * DERIVADO do último evento (custody | bank | factoring | supplier |
 * refunded | collection). "Recebido" (R) NÃO tem endpoint aqui — nasce só
 * na transação da baixa do faturamento (D8 — gancho em /api/billing/invoice).
 * Espelho no app: apps/web/lib/app/modules/checks/.
 */
const router = Router()

/**
 * @swagger
 * /api/checks:
 *   get:
 *     summary: Lista os cheques da institution por estado derivado
 *     tags: [Checks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [custody, bank, factoring, supplier, refunded, collection] }
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Número do cheque ou emitente
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, bankLabel, agency, account, number, issuer, value, dtCheck, headerKind, state, entityName }' }
 *       400: { description: status inválido }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/checks/banks:
 *   get:
 *     summary: Lookup do catálogo CENTRAL de bancos (FEBRABAN)
 *     tags: [Checks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, number, description }' }
 *       401: { description: Não autenticado }
 */
router.get('/banks', controller.banksLookup)

/**
 * @swagger
 * /api/checks/bank-accounts:
 *   get:
 *     summary: Lookup das contas correntes da institution (depósito/desconto/reembolso)
 *     tags: [Checks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, label }' }
 *       401: { description: Não autenticado }
 */
router.get('/bank-accounts', controller.bankAccountsLookup)

/**
 * @swagger
 * /api/checks/providers:
 *   get:
 *     summary: Lookup de fornecedores da institution (factoring — Q3 do parecer)
 *     tags: [Checks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, name }' }
 *       401: { description: Não autenticado }
 */
router.get('/providers', controller.providersLookup)

/**
 * @swagger
 * /api/checks/open-payables:
 *   get:
 *     summary: Lookup dos títulos a PAGAR abertos (uso em pagamento — D2)
 *     tags: [Checks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { orderId, parcel, number, entityName, dtExpiration, balance } (máx. 100)' }
 *       401: { description: Não autenticado }
 */
router.get('/open-payables', controller.openPayablesLookup)

/**
 * @swagger
 * /api/checks/{id}:
 *   get:
 *     summary: Detalhe do cheque — cabeçalho imutável + história completa
 *     tags: [Checks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — cheque completo (+ events[])' }
 *       401: { description: Não autenticado }
 *       404: { description: Cheque não encontrado }
 */
router.get('/:id', controller.getOne)

/**
 * @swagger
 * /api/checks/{id}/deposit:
 *   post:
 *     summary: DEPOSITA o cheque (evento B) — cofre → banco
 *     tags: [Checks]
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
 *             required: [dtRecord, bankAccountId]
 *             properties:
 *               dtRecord: { type: string, example: '2026-09-10' }
 *               bankAccountId: { type: integer }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { event, settledCode } }' }
 *       400: { description: 'Validação / conta inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: Cheque não encontrado }
 *       409: { description: 'CHECK_NOT_IN_CUSTODY / NO_OPEN_CASHIER' }
 */
router.post('/:id/deposit', controller.deposit)

/**
 * @swagger
 * /api/checks/{id}/discount:
 *   post:
 *     summary: DESCONTA o cheque na factoring (evento D) — 3 linhas, 1 código
 *     description: >
 *       Débito na custódia (conta 0, valor de face) + crédito no destino
 *       escolhido (0 = caixa ou uma conta) pelo valor de face + débito do
 *       custo/ágio informado. Fiel ao legado (reg_ctrl_cheque.pas): o ágio
 *       NÃO é calculado por %, é digitado pelo usuário.
 *     tags: [Checks]
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
 *             required: [dtRecord, factoringEntityId, bankAccountId]
 *             properties:
 *               dtRecord: { type: string }
 *               factoringEntityId: { type: integer, description: 'Lookup /providers' }
 *               bankAccountId: { type: integer, description: '0 = caixa' }
 *               feeValue: { type: number, default: 0 }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { event, settledCode } }' }
 *       400: { description: 'Validação / conta inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: Cheque não encontrado }
 *       409: { description: 'CHECK_NOT_IN_CUSTODY / NO_OPEN_CASHIER' }
 */
router.post('/:id/discount', controller.discount)

/**
 * @swagger
 * /api/checks/{id}/return-refund:
 *   post:
 *     summary: RETORNO com reembolso (evento T) — cheque sem fundos na factoring
 *     description: Dinheiro sai da empresa de volta para a factoring (D7a/D7c).
 *     tags: [Checks]
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
 *             required: [dtRecord, bankAccountId]
 *             properties:
 *               dtRecord: { type: string }
 *               bankAccountId: { type: integer, description: '0 = caixa' }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { event, settledCode } }' }
 *       401: { description: Não autenticado }
 *       404: { description: Cheque não encontrado }
 *       409: { description: 'CHECK_NOT_DISCOUNTED / NO_OPEN_CASHIER' }
 */
router.post('/:id/return-refund', controller.returnRefund)

/**
 * @swagger
 * /api/checks/{id}/return-good:
 *   post:
 *     summary: RETORNO bom (evento F) — pré-datado compensou na factoring, SEM movimento
 *     description: O cheque volta à custódia (D7b) — pode ser depositado, usado em pagamento ou entrar em novo desconto.
 *     tags: [Checks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note: { type: string, nullable: true, maxLength: 255 }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { event } }' }
 *       401: { description: Não autenticado }
 *       404: { description: Cheque não encontrado }
 *       409: { description: 'CHECK_NOT_DISCOUNTED' }
 */
router.post('/:id/return-good', controller.returnGood)

/**
 * @swagger
 * /api/checks/{id}/pay:
 *   post:
 *     summary: USA o cheque em pagamento (evento P) — quita um título a pagar (D2)
 *     tags: [Checks]
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
 *             required: [dtRecord, orderId, parcel]
 *             properties:
 *               dtRecord: { type: string }
 *               orderId: { type: integer, description: 'Lookup /open-payables' }
 *               parcel: { type: integer }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { event, settledCode } }' }
 *       401: { description: Não autenticado }
 *       404: { description: 'Cheque ou título não encontrado' }
 *       409: { description: 'CHECK_NOT_IN_CUSTODY / NO_OPEN_CASHIER' }
 */
router.post('/:id/pay', controller.pay)

/**
 * @swagger
 * /api/checks/{id}/return:
 *   post:
 *     summary: DEVOLVE o cheque (evento V) — sem fundos; cria título NOVO contra o cliente de origem
 *     tags: [Checks]
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
 *             required: [dtRecord]
 *             properties:
 *               dtRecord: { type: string }
 *               note: { type: string, nullable: true, maxLength: 255 }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { event, orderId } } — orderId = título novo criado' }
 *       401: { description: Não autenticado }
 *       404: { description: Cheque não encontrado }
 *       409: { description: 'CHECK_NOT_RETURNABLE / CHECK_NO_ORIGIN' }
 */
router.post('/:id/return', controller.returnToOrigin)

/**
 * @swagger
 * /api/checks/{id}/reverse:
 *   post:
 *     summary: ESTORNA o último evento do cheque (X)
 *     description: >
 *       Recusa (409 CHECK_ALREADY_MOVED) se não for o evento mais recente
 *       (D10). R/P: reverte a baixa do título e, se R, TODOS os cheques que
 *       compartilharam o mesmo settled_code (D9). B/D/T: inverte as linhas
 *       do movimento próprio. F: só grava o X (sem dinheiro). V não é
 *       suportado (cancele o título gerado).
 *     tags: [Checks]
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
 *             required: [event, reason]
 *             properties:
 *               event: { type: integer, description: 'Nº do evento a estornar (deve ser o último)' }
 *               reason: { type: string, maxLength: 100 }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { event, affectedCheckIds } }' }
 *       401: { description: Não autenticado }
 *       404: { description: 'Cheque ou evento não encontrado' }
 *       409: { description: 'CHECK_ALREADY_MOVED / CHECK_EVENT_NOT_REVERSIBLE' }
 */
router.post('/:id/reverse', controller.reverse)

export default router
