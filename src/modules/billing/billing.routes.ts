import { Router } from 'express'
import * as controller from './billing.controller'
import { requirePrivilegeFor, requireInterfaceFor } from '@shared/auth/require-privilege'
import { resolveFromBody, resolveFromParam } from './billing.interface-resolver'
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
// Q-G29: FATURAR na interface do RAMO (orders / order-returns; OS tem rota própria)
router.post('/invoice', requirePrivilegeFor(PRIVILEGE_FATURAR, resolveFromBody), controller.invoice)

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
 *       409: { description: "Não cancelável (INVOICE_NOT_CANCELLABLE), bloqueada (INVOICE_CANCEL_BLOCKED — o bloco fiscal traz barrier {kind, reason?, attempt}, D-F141) ou sem caixa aberto (NO_OPEN_CASHIER)" }
 *       503: { description: "A voz do fisco (banco do serviço fiscal) ilegível agora — FISCAL_VOICE_UNAVAILABLE com ref do alarme (D-F130); nada foi alterado" }
 *       500: { description: Erro interno }
 */
// Q-G16/Q-G22: CANCELAR na interface do RAMO do pedido — ciclo de OS vivo →
// `service-orders`, senão `orders` (orderId inválido cai em `orders`; o DTO recusa depois)
router.post('/cancel', requirePrivilegeFor(PRIVILEGE_CANCELAR, resolveFromBody), controller.cancel)

/**
 * @swagger
 * /api/billing/cancel-waiver:
 *   post:
 *     summary: Mantém a nota cuja NFS-e foi cancelada por SUBSTITUIÇÃO no fisco (e105102)
 *     description: >-
 *       Rodada 13 das APIs fiscais (D-F67/D-F72/D-F73/D-F74). O cancelamento por substituição é feito FORA do
 *       produto (portal do fisco) e gera uma NFS-e substituta que o ERP não conhece — por isso a voz C fica sem
 *       efeito automático (D-F64). Este ato registra a decisão humana de NÃO cancelar a nota no ERP (motivo e
 *       autoria em tb_invoice_cancel_waiver): a pendência some da seção "No fisco", do rodízio e do lote. A
 *       alternativa é cancelar a nota (POST /api/billing/cancel). Só vale para a
 *       voz C vigente com código 105102 em produção (voz lida no banco fiscal_api — F2a), nota viva e não cancelada. Idempotente por (nota, chave):
 *       repetir devolve alreadyWaived=true. Privilégio CANCELAR (7) na interface do ramo.
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
 *               reason:  { type: string, minLength: 1, maxLength: 255 }
 *     responses:
 *       200: { description: "{ ok, data: { orderId, accessKey, createdAt, alreadyWaived } }" }
 *       400: { description: Payload inválido / motivo ausente (VALIDATION_FAILED · INVOICE_REASON_REQUIRED) }
 *       401: { description: Sem JWT }
 *       403: { description: Sem privilégio CANCELAR no ramo (PRIVILEGE_REQUIRED) }
 *       404: { description: Nota não encontrada (INVOICE_NOT_FOUND) }
 *       409: { description: INVOICE_CANCEL_WAIVER_NOT_APPLICABLE (não é substituição, nota já cancelada ou efeito já aplicado) · RESOURCE_BUSY }
 *       503: { description: "A voz do fisco (banco do serviço fiscal) ilegível agora — FISCAL_VOICE_UNAVAILABLE com ref do alarme (D-F130); nada foi gravado" }
 */
router.post('/cancel-waiver', requirePrivilegeFor(PRIVILEGE_CANCELAR, resolveFromBody), controller.cancelWaiver)

// ---------------------------------------------------------------------------
// FISCO — F2a, etapa A3 (D-F4/D-F11/D-F115): o setes-api é PASSIVO. As 9 rotas fiscais daqui (transmitir, lote, pendentes,
// rodízio, cancelar no fisco, consultar, visão "No fisco", XML, DANFSe) MORRERAM — o app fala com a nfse-api direto (D-F4). Ficam
// só os FATOS DO ERP sobre a nota: o plano de cancelamento (consultivo) e o efeito da voz do fisco na nota (+ a dispensa acima).
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/billing/{orderId}/cancel-plan:
 *   get:
 *     summary: Plano de cancelamento da nota (consultivo — nada é gravado)
 *     description: >-
 *       F2a (D-F29/D-F115). O app consulta ANTES de pedir o cancelamento no fisco (nfse-api) e de mandar o
 *       POST /api/billing/cancel. É o MESMO cálculo do POST (uma política só), numa transação sempre desfeita:
 *       bloqueios locais (título baixado, boleto liquidado, cheque que avançou, devolução, OS do cliente aberta)
 *       e o bloco FISCAL lido da voz do fisco no banco fiscal_api — transmissão em andamento, NFS-e autorizada em
 *       produção (cancele no fisco primeiro) ou envio interrompido sem a PROVA da reconferência (reconfira na
 *       nfse-api). fiscalRecord diz o destino: com registro fiscal a nota fica (evento C) e o pedido vira C.
 *       cancellable também exige caixa aberto do operador quando o cancelamento grava linha de caixa (D16 — cashierOpen).
 *       Mudou entre a consulta e o POST = o POST recusa com o plano novo. O bloco fiscal traz a barreira TIPADA
 *       (barrier {kind: authorized|in-flight|cancel-in-flight|reconfirm, reason?, attempt} — D-F141) para a tela
 *       escolher a ação. Privilégio CANCELAR na interface do ramo — a guarda do POST (D-F131); a consulta espera
 *       trava no máximo 3 s (409 RESOURCE_BUSY — nunca segura a nota que a nfse-api trava).
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: orderId, required: true, schema: { type: integer, minimum: 1 } }
 *     responses:
 *       200: { description: "{ ok, data: { orderId, invoiceNumber, cancellable, blocks[{field: title|bankSlip|check|return|serviceOrder|fiscal, ref, message, barrier? (só no fiscal)}], fiscalRecord, effects: { bankSlipsToCancel[], releasedTitles[], checksToReverse[{checkId, number}], commissionsToCompensate, touchesCash, cashierOpen (D16 do operador — null quando não toca o caixa) } } }" }
 *       400: { description: orderId inválido (INVALID_ID) }
 *       401: { description: Sem JWT }
 *       403: { description: Interface do ramo não contratada (INTERFACE_NOT_ALLOWED) ou sem o privilégio CANCELAR (PRIVILEGE_REQUIRED) }
 *       404: { description: Pedido/nota não encontrados (ORDER_NOT_FOUND · INVOICE_NOT_FOUND) }
 *       409: { description: Pedido não faturado / nota não cancelável (INVOICE_NOT_CANCELLABLE) · RESOURCE_BUSY (trava além de 3 s) }
 *       503: { description: "A voz do fisco (banco do serviço fiscal) ilegível agora — FISCAL_VOICE_UNAVAILABLE com ref do alarme (D-F130)" }
 */
// D-F131 (= Q-F139 (a)): a MESMA guarda do POST — quem não pode cancelar não segura as travas do plano
router.get('/:orderId/cancel-plan', requirePrivilegeFor(PRIVILEGE_CANCELAR, resolveFromParam), controller.cancelPlan)

/**
 * @swagger
 * /api/billing/{orderId}/fiscal-effect:
 *   get:
 *     summary: Efeito da voz do fisco na nota (D-F114) e a dispensa vigente
 *     description: >-
 *       F2a (D-F79/D-F114/D-F115). Classificação DERIVADA da voz vigente da vida vigente (banco fiscal_api) × nota ×
 *       dispensa: none (nada a fazer) · apply (o fisco cancelou — aplique o cancelamento local pelo POST
 *       /api/billing/cancel) · decide (NFS-e SUBSTITUÍDA no fisco, e105102, em produção — "manter a nota" pelo POST
 *       /api/billing/cancel-waiver ou cancelar a nota) · cancel (cancelamento DE OFÍCIO e305101, ou substituição em
 *       homologação — cancele a nota). A tela "No fisco" compõe com a nfse-api (a voz em si). Leitura sem trava.
 *       Interface do ramo contratada (D-F37).
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: orderId, required: true, schema: { type: integer, minimum: 1 } }
 *     responses:
 *       200: { description: "{ ok, data: { orderId, lifeEvent, invoiceCancelled, effect: none|apply|decide|cancel, cancelWaiver: { accessKey, reason, userId, createdAt } | null } }" }
 *       400: { description: orderId inválido (INVALID_ID) }
 *       401: { description: Sem JWT }
 *       403: { description: Interface do ramo não contratada (INTERFACE_NOT_ALLOWED) }
 *       404: { description: Nota não encontrada (INVOICE_NOT_FOUND) }
 *       409: { description: RESOURCE_BUSY (a nota mudou durante a leitura) }
 *       503: { description: "A voz do fisco (banco do serviço fiscal) ilegível agora — FISCAL_VOICE_UNAVAILABLE com ref do alarme (D-F130); nunca 'nada pendente' calado" }
 */
router.get('/:orderId/fiscal-effect', requireInterfaceFor(resolveFromParam), controller.fiscalEffect)


export default router
