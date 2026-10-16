import { Router } from 'express'
import * as controller from './settlement-rules.controller'

/**
 * Rotas do módulo settlement-rules — montadas em /api/settlement-rules.
 * Cadastro de CLIENTE, grupo Financeiro (sem superGuard — escopo por
 * institution do JWT); gate técnico = flag 'settlement-rules'.
 * Espelho no app: apps/web/lib/app/modules/settlement_rules/.
 * O {id} dos recursos é o tb_payment_types_id (1 contrato por forma — D2).
 */
const router = Router()

/**
 * @swagger
 * /api/settlement-rules:
 *   get:
 *     summary: Lista as regras de recebimento (baixa automática por forma) da institution
 *     tags: [SettlementRules]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por forma de pagamento ou banco
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *       - in: query
 *         name: criteria
 *         schema: { type: string }
 *         description: 'Pesquisa avançada (D-BA1) — JSON { chave: valor } com as chaves de GET /search-criteria; texto = contém, faixa = { from, to }, lookup = id, options = [valores], bool = true|false. Soma em E com filter. Desconhecida/malformada = 400 SEARCH_CRITERIA_INVALID; valor inválido = 422 SEARCH_CRITERION_INVALID com fields[]'
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id (= paymentTypeId), paymentTypeId, paymentTypeDescription, paymentTypeKind, bankAccountId (0 = caixa), bankAccountLabel, feeRate, paymentTerm, expirationDate }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Cria a regra de recebimento de uma forma de pagamento
 *     description: >
 *       Política de baixa automática (migration 038 — D1–D22): a PRESENÇA do
 *       contrato faz o faturamento baixar o título na conta indicada
 *       (bankAccountId 0 = caixa, exige caixa do usuário aberto; > 0 = conta
 *       corrente, validada) com taxa (feeRate %, débito no mesmo código de
 *       baixa) e prazo (paymentTerm dias — dt_record = faturamento + prazo ×
 *       parcela). 1 contrato por forma: existente → 409
 *       SETTLEMENT_RULE_EXISTS; excluído → revive. Forma precisa estar
 *       vinculada à empresa (400 PAYMENT_TYPE_NOT_LINKED). Cheque/boleto:
 *       contrato aceito mas não altera o fluxo (D16/D18).
 *     tags: [SettlementRules]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentTypeId]
 *             properties:
 *               paymentTypeId: { type: integer, description: 'Forma vinculada (lookup /payment-types)' }
 *               bankAccountId: { type: integer, default: 0, description: '0 = caixa; > 0 = conta (lookup /bank-accounts)' }
 *               feeRate: { type: number, default: 0, description: 'Taxa % da operadora' }
 *               paymentTerm: { type: integer, default: 0, description: 'Dias até o dinheiro cair' }
 *               expirationDate: { type: string, nullable: true, example: '2027-12-31' }
 *               note: { type: string, nullable: true }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } } — id = paymentTypeId' }
 *       400: { description: 'Validação / forma não vinculada / conta inexistente' }
 *       401: { description: Não autenticado }
 *       409: { description: 'SETTLEMENT_RULE_EXISTS' }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/settlement-rules/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de regras de recebimento
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       declarada no módulo, sem expressão SQL.
 *     tags: [SettlementRules]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind (text|number|money|date|lookup|options|bool|federalId — prefixo da inscrição federal, D-CJ9), labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', controller.searchCriteria)
router.post('/', controller.create)

/**
 * @swagger
 * /api/settlement-rules/payment-types:
 *   get:
 *     summary: Lookup das formas de pagamento vinculadas e habilitadas (com flag hasContract)
 *     tags: [SettlementRules]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, description, kind, hasContract }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/payment-types', controller.paymentTypesLookup)

/**
 * @swagger
 * /api/settlement-rules/bank-accounts:
 *   get:
 *     summary: Lookup das contas correntes da institution
 *     tags: [SettlementRules]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, label }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/bank-accounts', controller.bankAccountsLookup)

/**
 * @swagger
 * /api/settlement-rules/{id}:
 *   get:
 *     summary: Retorna o contrato pela forma de pagamento (id = paymentTypeId)
 *     tags: [SettlementRules]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — contrato completo (+ note)' }
 *       401: { description: Não autenticado }
 *       404: { description: Contrato não encontrado }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualiza o contrato (a forma não muda — é a PK)
 *     tags: [SettlementRules]
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
 *             properties:
 *               bankAccountId: { type: integer }
 *               feeRate: { type: number }
 *               paymentTerm: { type: integer }
 *               expirationDate: { type: string, nullable: true }
 *               note: { type: string, nullable: true }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: 'Validação / conta inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: Contrato não encontrado }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Exclui o contrato (soft delete — a forma volta a "sem baixa automática")
 *     tags: [SettlementRules]
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
