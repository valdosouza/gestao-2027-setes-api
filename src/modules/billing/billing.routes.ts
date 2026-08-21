import { Router } from 'express'
import * as controller from './billing.controller'

/**
 * Rotas do faturamento (/api/billing — W2 Onda 3, rodada R4). Processo, não
 * cadastro: dois POSTs. Flag técnica 'billing'.
 */
const router = Router()

/**
 * @swagger
 * /api/billing/validate:
 *   post:
 *     summary: Valida a ordem para faturamento (lote completo)
 *     description: >-
 *       Valida emitente, destinatário e itens de UMA vez e devolve a LISTA
 *       COMPLETA de pendências (nunca para na primeira). Para cada item de
 *       mercadoria SEM escolha manual de regra, roda o motor de match e
 *       GRAVA a regra encontrada (tb_order_item_tax_rule, origin 'A') — o
 *       faturamento consome a regra gravada sem rebuscar. Escolha manual
 *       (origin 'M') nunca é sobrescrita. issues vazio = pronto p/ faturar.
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderId]
 *             properties:
 *               orderId: { type: integer }
 *               adjustment:
 *                 type: object
 *                 description: Obrigatório para ordem de AJUSTE (sentido + CFOP)
 *                 properties:
 *                   direction: { type: string, enum: [E, S] }
 *                   cfopId: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: { orderId, branch, issues[], rulesResolved, rulesManual } }" }
 *       400: { description: Payload inválido }
 *       401: { description: Sem JWT }
 *       403: { description: Flag billing desabilitada }
 *       404: { description: Ordem não encontrada }
 *       409: { description: Ordem já faturada }
 *       422: { description: Ordem sem ramo identificado }
 *       500: { description: Erro interno }
 */
router.post('/validate', controller.validate)

/**
 * @swagger
 * /api/billing/invoice:
 *   post:
 *     summary: Fatura a ordem (nota + impostos por item + financeiro)
 *     description: >-
 *       Consome as regras GRAVADAS pela validação (item sem regra = 422
 *       REQUIRES_VALIDATION). Calcula os tributos por item na ordem T1
 *       (@shared/tax-rule), grava nas tabelas de imposto por item, gera
 *       tb_invoice (número MAX+1 por modelo+série; série da config
 *       invoice_serie) + tb_invoice_merchandise e MATERIALIZA o financeiro
 *       (tb_order_installment elaborado, senão o prazo gera as parcelas) —
 *       tudo em UMA transação. Nota nasce NÃO transmitida (status '0').
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderId]
 *             properties:
 *               orderId: { type: integer }
 *               useMvaOriginal:
 *                 type: boolean
 *                 description: true = MVA original do cadastro; false (default) = MVA ajustada pela carga real (P3.2)
 *               adjustment:
 *                 type: object
 *                 properties:
 *                   direction: { type: string, enum: [E, S] }
 *                   cfopId: { type: string }
 *     responses:
 *       201: { description: "{ ok, data: { orderId, invoiceNumber, serie, model, totalValue, parcels } }" }
 *       400: { description: Payload inválido }
 *       401: { description: Sem JWT }
 *       403: { description: Flag billing desabilitada }
 *       404: { description: Ordem não encontrada }
 *       409: { description: Ordem já faturada }
 *       422: { description: Pendências de validação (REQUIRES_VALIDATION) ou negociação ausente }
 *       500: { description: Erro interno }
 */
router.post('/invoice', controller.invoice)

export default router
