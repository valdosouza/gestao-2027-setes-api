import { Router } from 'express'
import * as controller from './billing.controller'
import { requirePrivilege, requirePrivilegeFor } from '@shared/auth/require-privilege'
import { hasServiceOrderCycle } from '@shared/service-order'
import { PRIVILEGE_FATURAR, PRIVILEGE_CANCELAR } from '@shared/auth/privileges'

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
 *                   returnedOrderId:
 *                     type: integer
 *                     description: >-
 *                       Devolução de mercadoria — id do pedido de VENDA
 *                       original (exige direction E e pedido FATURADO).
 *                       Valida cliente, itens, saldo devolvível acumulado e
 *                       valor unitário; o vendedor é DERIVADO do pedido
 *                       original.
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
 *                   returnedOrderId:
 *                     type: integer
 *                     description: >-
 *                       Devolução de mercadoria — id do pedido de VENDA
 *                       original. Revalidado como gate DURO (422
 *                       RETURN_INVALID / RETURN_REQUIRES_ENTRY); grava a
 *                       âncora + elos por item e a comissão NEGATIVA do
 *                       vendedor derivado. Venda gera comissão POSITIVA por
 *                       item na mesma transação (kind F).
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
// Q-P5 (cancelamento, 2026-09-08): FATURAR e CANCELAR são privilégios de
// AÇÃO da interface 'orders' aplicados na rota (super/admin passam).
router.post('/invoice', requirePrivilege('orders', PRIVILEGE_FATURAR), controller.invoice)

/**
 * @swagger
 * /api/billing/cancel:
 *   post:
 *     summary: Cancela a nota de um pedido faturado (nota NÃO transmitida)
 *     description: >-
 *       Desfaz o faturamento (prompt_cancelamento_nota.md D1–D17): exige
 *       motivo; RECUSA se houver título baixado, boleto liquidado, cheque que
 *       avançou de estado ou devolução apontando para a nota (409
 *       INVOICE_CANCEL_BLOCKED com fields[] tipado — resolva antes). Cancela
 *       boletos abertos, estorna o recebimento dos cheques em custódia (exige
 *       caixa aberto — D16), compensa a comissão, soft-deleta financeiro,
 *       snapshots fiscais e a nota (número liberado — D4), grava o evento C
 *       e devolve o pedido a aberto (refaturável). Privilégio CANCELAR (7).
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderId, reason]
 *             properties:
 *               orderId: { type: integer }
 *               reason:  { type: string, maxLength: 255 }
 *     responses:
 *       200: { description: "{ ok, data: { orderId, invoiceNumber, event, checksReversed[], bankSlipsCancelled[], releasedTitles[{bankSlipId, orderId, parcel}] (D-G9: títulos de OUTROS pedidos liberados do boleto agrupado cancelado), commissionsCompensated } } — pedido de ORDEM DE SERVIÇO volta a aberta (Q-G3; bloco serviceOrder se o cliente já tem outra OS aberta)" }
 *       400: { description: Payload inválido / motivo ausente (INVOICE_REASON_REQUIRED) }
 *       401: { description: Sem JWT }
 *       403: { description: Flag billing desabilitada ou sem privilégio CANCELAR (PRIVILEGE_REQUIRED) }
 *       404: { description: Pedido/nota não encontrados }
 *       409: { description: Não cancelável (INVOICE_NOT_CANCELLABLE), bloqueada (INVOICE_CANCEL_BLOCKED) ou sem caixa aberto (NO_OPEN_CASHIER) }
 *       500: { description: Erro interno }
 */
// Q-G16/Q-G22: CANCELAR na interface do RAMO do pedido — ciclo de OS vivo →
// `service-orders`, senão `orders` (orderId inválido cai em `orders`; o DTO recusa depois)
router.post('/cancel', requirePrivilegeFor(PRIVILEGE_CANCELAR, async req => {
  const orderId = Number(req.body?.orderId)
  const inst = req.institution!
  return Number.isInteger(orderId) && orderId > 0
      && await hasServiceOrderCycle(inst.schemaName, inst.institutionId, orderId)
    ? 'service-orders' : 'orders'
}), controller.cancel)

export default router
