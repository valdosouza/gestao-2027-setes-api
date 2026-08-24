import { Router } from 'express'
import * as controller from './cashier.controller'

/**
 * Rotas do módulo cashier — montadas em /api/cashier (W3.2, parecer
 * setes-conceito 2026-08-22). Tela de PROCESSO do financeiro; sem
 * superGuard (escopo por institution do JWT); flag 'cashier'.
 */
const router = Router()

/**
 * @swagger
 * /api/cashier/current:
 *   get:
 *     summary: Sessão de caixa ABERTA do usuário corrente (ou null)
 *     tags: [Cashier]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data: CashierRow | null }' }
 *       401: { description: Não autenticado }
 */
router.get('/current', controller.current)

/**
 * @swagger
 * /api/cashier/open:
 *   post:
 *     summary: Abre uma sessão de caixa (dia+usuário+terminal=0 — Q-Caixa 5)
 *     tags: [Cashier]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       201: { description: 'Envelope { ok, data: CashierRow }' }
 *       401: { description: Não autenticado }
 *       409: { description: 'Já existe um caixa aberto para este usuário (CASHIER_ALREADY_OPEN)' }
 */
router.post('/open', controller.openCashier)

/**
 * @swagger
 * /api/cashier/{id}:
 *   get:
 *     summary: Saldo DERIVADO da sessão + registrado por forma de pagamento
 *     tags: [Cashier]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data: { cashier, balance, registeredByPaymentType[] } }' }
 *       401: { description: Não autenticado }
 *       404: { description: Caixa não encontrado }
 */
router.get('/:id', controller.balance)

/**
 * @swagger
 * /api/cashier/{id}/withdraw:
 *   post:
 *     summary: "Retirada/transferência (Pc_RetiraValorCaixa): débito no caixa, opcional crédito espelhado numa conta"
 *     tags: [Cashier]
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
 *             required: [value, history]
 *             properties:
 *               value: { type: number }
 *               history: { type: string, maxLength: 100 }
 *               destinationBankAccountId: { type: integer, nullable: true, description: 'Informado = transferência (crédito espelhado); ausente = retirada simples' }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { statementId, destinationStatementId } }' }
 *       400: { description: 'Conta bancária de destino inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: Caixa não encontrado }
 *       409: { description: 'Caixa fechado (CASHIER_NOT_OPEN)' }
 */
router.post('/:id/withdraw', controller.withdrawFromCashier)

/**
 * @swagger
 * /api/cashier/{id}/close:
 *   post:
 *     summary: "Fechamento (Pc_FechaCaixaNormal): conferência registrado×digitado + transferência opcional do saldo"
 *     description: >
 *       Grava tb_cashier_items (kind 'F') com o valor DIGITADO por forma de
 *       pagamento e a diferença contra o REGISTRADO — só auditoria, não
 *       bloqueia (Q-Caixa 3, replica o legado). transferBankAccountId
 *       opcional desvia o saldo total pra uma conta bancária no fechamento.
 *     tags: [Cashier]
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
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [paymentTypeId, countedValue]
 *                   properties:
 *                     paymentTypeId: { type: integer }
 *                     countedValue: { type: number }
 *               transferBankAccountId: { type: integer, nullable: true }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { cashierId, hrEnd, items[], transfer } }' }
 *       401: { description: Não autenticado }
 *       404: { description: Caixa não encontrado }
 *       409: { description: 'Caixa já fechado (CASHIER_ALREADY_CLOSED)' }
 */
router.post('/:id/close', controller.closeCashier)

export default router
