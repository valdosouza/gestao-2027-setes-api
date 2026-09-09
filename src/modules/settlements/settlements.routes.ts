import { Router } from 'express'
import * as controller from './settlements.controller'

/**
 * Rotas do módulo settlements — montadas em /api/settlements.
 * TELA DE PROCESSO do financeiro (grupo Financeiro; sem superGuard —
 * escopo por institution do JWT); gate técnico = flag 'settlements'.
 * Espelho no app: apps/web/lib/app/modules/settlements/.
 */
const router = Router()

/**
 * @swagger
 * /api/settlements/bills:
 *   get:
 *     summary: Carteira de títulos (saldo DERIVADO — aberto = tag − Σ pagos vigentes)
 *     tags: [Settlements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, settled] }
 *         description: open = com saldo; settled = com algum pagamento vigente
 *       - in: query
 *         name: kind
 *         schema: { type: string, enum: [RA, RM, PA, PM] }
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por entidade (da CADEIA DA ORDEM — DP10) ou nº do título
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { orderId, parcel, number, kind, situation, operation, stage, dtExpiration, tagValue, paidValue, balance, entityName, paymentTypeId, paymentTypeDescription }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/bills', controller.bills)

/**
 * @swagger
 * /api/settlements:
 *   post:
 *     summary: "Baixa em LOTE: N títulos → 1 settled_code → 1 movimento (N:1)"
 *     description: >
 *       Fase 6.1 do 05-ORDEM-SERVICO. Juros/multa/desconto/valor pago são
 *       INFORMADOS (P5 — cálculo automático futuro; o líquido sugerido é
 *       conta do app). settled_code nasce MAX+1 por institution (DP9);
 *       cada título ganha um payment status 'N' com event MAX+1 da parcela
 *       e stage 'B' (conta) ou 'C' (caixa 0); UM statement consolida
 *       créditos × débitos do lote (planos financeiros: override do lote
 *       ou defaults da forma de pagamento — Formas v2). Pagamento PARCIAL
 *       permitido — o saldo do título é derivado.
 *     tags: [Settlements]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [titles, bankAccountId, dtPayment]
 *             properties:
 *               titles:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [orderId, parcel, paidValue]
 *                   properties:
 *                     orderId: { type: integer }
 *                     parcel: { type: integer }
 *                     interestValue: { type: number, default: 0 }
 *                     lateValue: { type: number, default: 0 }
 *                     discountAliquot: { type: number, default: 0 }
 *                     paidValue: { type: number }
 *               bankAccountId: { type: integer, description: '0 = Caixa; > 0 = conta corrente' }
 *               dtPayment: { type: string, description: 'Data prevista/lançada (P8)' }
 *               dtRealPayment: { type: string, nullable: true, description: 'Data em que o valor efetivamente entrou/saiu (P8)' }
 *               financialPlanCreId: { type: integer, nullable: true }
 *               financialPlanDebId: { type: integer, nullable: true }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { settledCode, statementId, totalValue, titles, paOrders } } — paOrders = ordens PA geradas pela rotina de parcerias (recebimentos RA/RM de cliente com parceria viva: 1 tb_order + tb_order_financial + título PA por parceiro, % × pago, venc. = baixa + 12 dias — DP12)' }
 *       400: { description: 'Validação / conta inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: Título não encontrado }
 *       500: { description: Erro interno }
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/settlements/settled:
 *   get:
 *     summary: Baixas registradas (eventos por parcela, com a trilha N/E/R do estorno)
 *     tags: [Settlements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { orderId, parcel, event, number, kind, entityName, paidValue, dtPayment, dtRealPayment, settledCode, status, originEvent, reversalReason }' }
 *       401: { description: Não autenticado }
 */
router.get('/settled', controller.settled)

/**
 * @swagger
 * /api/settlements/reversal:
 *   post:
 *     summary: "Estorno IMUTÁVEL (5.5): lançamento inverso + marcação — nada se apaga"
 *     description: >
 *       Gera payment INVERSO (event novo, status 'R', origin_event, motivo,
 *       settled_code próprio) + statement inverso (crédito↔débito trocados,
 *       status 'R', id_origin); original vira status 'E'; o statement
 *       original só vira 'E' quando TODOS os payments do código forem
 *       estornados (estorno PARCIAL em código compartilhado — P2 resolvida);
 *       título volta a aberto (estado derivado; stage volta a 'N').
 *     tags: [Settlements]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderId, parcel, event, reason]
 *             properties:
 *               orderId: { type: integer }
 *               parcel: { type: integer }
 *               event: { type: integer }
 *               reason: { type: string, maxLength: 100 }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { reversalEvent, settledCode, checksReversed[], paReversed, paCompensated } } — checksReversed/checksKept (D-G7/D-G7a): baixa feita com cheque SEMPRE estorna — a peça do cheque cancela (X) o R/P dos cheques ainda em custódia (checksReversed) e deixa como estão os que já transitaram (checksKept). Cadeia PA (4.3.3+DP11): baixas de PA estornadas recursivamente e títulos de compensação PA+C gerados (empresa tem crédito com o colaborador; saldo do parceiro zera)' }
 *       401: { description: Não autenticado }
 *       404: { description: Baixa não encontrada }
 *       409: { description: 'Baixa não está vigente (já estornada ou é um registro de estorno)' }
 *       500: { description: Erro interno }
 */
router.post('/reversal', controller.reversal)

/**
 * @swagger
 * /api/settlements/statements:
 *   get:
 *     summary: Movimento financeiro (extrato banco/caixa) com totais VIGENTES (status N)
 *     tags: [Settlements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: bankAccountId
 *         schema: { type: integer }
 *         description: 0 = Caixa; omitido = todas as contas
 *       - in: query
 *         name: dtFrom
 *         schema: { type: string }
 *       - in: query
 *         name: dtTo
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data: { rows[], totalCredit, totalDebit, balance } } — E/R aparecem como trilha mas não somam' }
 *       400: { description: Parâmetros inválidos }
 *       401: { description: Não autenticado }
 */
router.get('/statements', controller.statements)

export default router
