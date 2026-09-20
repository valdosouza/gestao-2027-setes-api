import { Router } from 'express'
import * as controller from './bank-slips.controller'
import * as registration from './bank-slips.registration.controller'

/**
 * Rotas do módulo bank-slips — montadas em /api/bank-slips (tela de
 * PROCESSO, grupo Financeiro; flag 'bank-slips'). Boleto = instrumento de
 * cobrança de 1..N títulos; estado DERIVADO do último evento
 * (open | settled | cancelled). Espelho no app: modules/bank_slips/.
 */
const router = Router()

/**
 * @swagger
 * /api/bank-slips:
 *   get:
 *     summary: Lista os boletos da institution por estado derivado
 *     tags: [BankSlips]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, settled, cancelled] }
 *         description: Estado derivado do último evento (vazio = todos)
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Nosso número ou nº do documento
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, ourNumber, documentNumber, dtEmission, dtExpiration, value, state, bankAccountLabel, customerName, titles }' }
 *       400: { description: status inválido }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: EMITE um boleto (evento E) para 1 título ou N títulos do mesmo cliente
 *     description: >
 *       prompt_boleto_emitido.md D1–D11. Congela taxas/instruções da carteira
 *       (tb_bank_charge_agreement ATIVA — D8), reserva o nosso número
 *       (sequência da carteira; sem faixa = id — D3), valor = soma dos saldos.
 *       Individual: vencimento default = do título; agrupado: vencimento
 *       OBRIGATÓRIO e títulos do MESMO cliente (D9). Título a pagar, quitado
 *       ou já com boleto vigente → 409.
 *     tags: [BankSlips]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agreementId, titles]
 *             properties:
 *               agreementId: { type: integer, description: 'Carteira ativa (lookup /agreements)' }
 *               titles:
 *                 type: array
 *                 items: { type: object, properties: { orderId: { type: integer }, parcel: { type: integer } } }
 *               dtExpiration: { type: string, nullable: true, example: '2026-10-10' }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id, ourNumber, documentNumber, value, dtExpiration, titles } }' }
 *       400: { description: 'Validação / agrupado sem vencimento (BANK_SLIP_EXPIRATION_REQUIRED)' }
 *       401: { description: Não autenticado }
 *       404: { description: 'AGREEMENT_NOT_FOUND / TITLE_NOT_FOUND' }
 *       409: { description: 'AGREEMENT_INACTIVE / BANK_NOT_FOUND / TITLE_NOT_RECEIVABLE / TITLE_SETTLED / TITLE_HAS_OPEN_SLIP / BANK_SLIP_MIXED_CUSTOMERS' }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.issue)

/**
 * @swagger
 * /api/bank-slips/agreements:
 *   get:
 *     summary: Lookup das carteiras de cobrança ATIVAS (D8)
 *     tags: [BankSlips]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, agreement, bankAccountLabel, hasRange }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/agreements', controller.agreementsLookup)

/**
 * @swagger
 * /api/bank-slips/open-titles:
 *   get:
 *     summary: Lookup dos títulos a receber ABERTOS sem boleto vigente (candidatos à emissão)
 *     tags: [BankSlips]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Cliente (nome) ou nº do título
 *       - in: query
 *         name: customerId
 *         schema: { type: integer }
 *         description: Restringe a um cliente (agrupamento — D9)
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { orderId, parcel, number, customerId, entityName, dtExpiration, balance, paymentTypeDescription } (máx. 100)' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/open-titles', controller.openTitlesLookup)

/**
 * @swagger
 * /api/bank-slips/{id}:
 *   get:
 *     summary: Detalhe do boleto — cabeçalho congelado + títulos + eventos
 *     tags: [BankSlips]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — boleto completo (+ titleRows[], events[])' }
 *       401: { description: Não autenticado }
 *       404: { description: Boleto não encontrado }
 *       500: { description: Erro interno }
 */
/**
 * @swagger
 * /api/bank-slips/refresh:
 *   post:
 *     tags: [BankSlips]
 *     summary: Consulta ativa — atualiza com o banco as apresentações vivas (Onda 2, D-I9)
 *     description: |
 *       Gatilho da Onda 2 (sem URL pública para webhook até a Onda 4): a tela chama ao
 *       abrir e no botão "Atualizar com o banco". THROTTLE — só apresentações cujo
 *       último evento tem mais de `minMinutes` (default 5), no máximo `limit` (default 8)
 *       por chamada (rate limit do sandbox: 10/min). Antes, reconcilia envios
 *       interrompidos por seuNumero (D-I13). Banco fora → para cedo (fail-closed).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { minMinutes: { type: integer }, limit: { type: integer } } }
 *     responses:
 *       200: { description: 'Envelope { ok, data: { checked, changed, reconciled, errors[], stoppedEarly } }' }
 */
router.post('/refresh', registration.refreshOpen)

router.get('/:id', controller.getOne)

/**
 * @swagger
 * /api/bank-slips/{id}/settle:
 *   post:
 *     summary: LIQUIDA manualmente (evento L) — 1 baixa para os N títulos sob UM settled_code
 *     description: >
 *       D5/D7: statement na conta CONGELADA do boleto com doc_reference =
 *       nosso número; valor rateado por título na proporção do vínculo,
 *       sobra sobre o valor de face vai como juros no último título; tarifa
 *       fica para a conciliação. Só boleto em aberto (409 BANK_SLIP_NOT_OPEN).
 *     tags: [BankSlips]
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
 *             required: [paidValue, dtPayment]
 *             properties:
 *               paidValue: { type: number }
 *               dtPayment: { type: string, example: '2026-09-10' }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { settledCode, statementId, event, titles } }' }
 *       400: { description: Validação }
 *       401: { description: Não autenticado }
 *       404: { description: Boleto não encontrado }
 *       422: { description: 'BANK_SLIP_FUTURE_PAYMENT — data do pagamento no futuro (D-G36)' }
 *       409: { description: 'BANK_SLIP_NOT_OPEN' }
 *       500: { description: Erro interno }
 */
router.post('/:id/settle', controller.settle)

/**
 * @swagger
 * /api/bank-slips/{id}/cancel:
 *   post:
 *     summary: CANCELA o boleto (evento C) — libera os títulos para reemissão ou outra forma
 *     tags: [BankSlips]
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
 *       404: { description: Boleto não encontrado }
 *       409: { description: 'BANK_SLIP_NOT_OPEN (liquidado ou já cancelado)' }
 *       500: { description: Erro interno }
 */
router.post('/:id/cancel', controller.cancel)

/**
 * @swagger
 * /api/bank-slips/{id}/reverse:
 *   post:
 *     summary: ESTORNA a liquidação (evento X) — inverte todas as baixas do settled_code e reabre o boleto
 *     tags: [BankSlips]
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
 *             required: [reason]
 *             properties:
 *               reason: { type: string, maxLength: 100 }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { event, reversed, settledCode } }' }
 *       401: { description: Não autenticado }
 *       404: { description: Boleto não encontrado }
 *       409: { description: 'BANK_SLIP_NOT_SETTLED (último evento não é L)' }
 *       500: { description: Erro interno }
 */
router.post('/:id/reverse', controller.reverse)

/**
 * @swagger
 * /api/bank-slips/{id}/register:
 *   post:
 *     tags: [BankSlips]
 *     summary: Apresenta o boleto ao banco (registro) — Onda 2, D-I5…D-I7
 *     description: |
 *       Cria a apresentação `attempt` N (`tb_bank_slip_registration`) e envia ao banco
 *       pelo canal API da CONTA do boleto. Emissão ASSÍNCRONA: volta `requestCode`
 *       (codigoSolicitacao); linha digitável/Pix chegam na consulta. Pagador vem da
 *       cadeia do cliente — incompleto → 422 BANK_PAYER_INCOMPLETE com o campo.
 *       Boleto com apresentação vigente → 409 BANK_SLIP_ALREADY_REGISTERED. Banco
 *       recusou → a tentativa fica como F e o erro do banco volta (422/503).
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       201: { description: 'Envelope { ok, data: { slipId, attempt, requestCode, environment } }' }
 *       409: { description: Já registrado / canal ausente / boleto não aberto }
 *       422: { description: Pagador incompleto / banco recusou }
 *       503: { description: Banco indisponível }
 * /api/bank-slips/{id}/refresh:
 *   post:
 *     tags: [BankSlips]
 *     summary: Consulta o banco e grava a VOZ dele sobre a apresentação vigente
 *     description: Idempotente — mesma situação e data não geram evento. RECEBIDO → liquidação (L, source A); CANCELADO/EXPIRADO → C; efeito recusado pelas nossas regras fica como pendência (`effectRefused`).
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data: { changed, kind, bankStatus, slipEvent, effectRefused } }' }
 *       409: { description: Nunca apresentado }
 * /api/bank-slips/{id}/pdf:
 *   get:
 *     tags: [BankSlips]
 *     summary: PDF oficial do banco (base64)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data: { pdfBase64, requestCode } }' }
 *       409: { description: Não registrado }
 * /api/bank-slips/{id}/pay-sandbox:
 *   post:
 *     tags: [BankSlips]
 *     summary: SANDBOX — simula o pagamento no banco e consulta (prova do critério 2 da Onda 2)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { via: { type: string, enum: [BOLETO, PIX] } } }
 *     responses:
 *       200: { description: 'Envelope { ok, data } (forma do refresh)' }
 *       409: { description: Fora do sandbox / sem apresentação }
 */
router.post('/:id/register', registration.register)
router.post('/:id/refresh', registration.refresh)
router.get('/:id/pdf', registration.pdf)
router.post('/:id/pay-sandbox', registration.paySandboxHandler)

export default router
