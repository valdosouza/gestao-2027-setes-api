import { Router } from 'express'
import * as controller from './billing.controller'
import * as fiscal from './billing.fiscal.controller'
import { requirePrivilegeFor, requirePrivilege, requireInterfaceFor } from '@shared/auth/require-privilege'
import { resolveFromBody, resolveFromParam } from './billing.interface-resolver'
import { PRIVILEGE_FATURAR, PRIVILEGE_CANCELAR, PRIVILEGE_TRANSMITIR } from '@shared/auth/privileges'

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
 *       409: { description: Não cancelável (INVOICE_NOT_CANCELLABLE), bloqueada (INVOICE_CANCEL_BLOCKED) ou sem caixa aberto (NO_OPEN_CASHIER) }
 *       500: { description: Erro interno }
 */
// Q-G16/Q-G22: CANCELAR na interface do RAMO do pedido — ciclo de OS vivo →
// `service-orders`, senão `orders` (orderId inválido cai em `orders`; o DTO recusa depois)
router.post('/cancel', requirePrivilegeFor(PRIVILEGE_CANCELAR, resolveFromBody), controller.cancel)

// ---------------------------------------------------------------------------
// FISCO — Onda 3 NFS-e (composição @shared/invoice-transmission, D-N3/D-N7/D-N9/D-E14)
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/billing/transmit:
 *   post:
 *     summary: Transmite o DPS da nota de serviço ao fisco (Sefin Nacional/ADN)
 *     description: >-
 *       Onda 3 NFS-e. Reserva a tentativa (attempt N+1) sob lock da nota — a
 *       institution é travada PRIMEIRO para cunhar o nDPS write-once (D-N3) —,
 *       monta e assina o DPS (emitente = estabelecimento, tomador = entidade da
 *       nota, serviço = ramo congelado no faturamento), fala com o fisco FORA da
 *       transação e grava a voz: A (autorizada — chave 50, número, dhProc, XML em
 *       disco), R (rejeitada — E0xxx em fields[]) ou F (credencial recusada).
 *       Desfecho ambíguo (503/502) NÃO fecha estado: a tentativa fica em voo e a
 *       consulta por dps_id reconcilia. Privilégio TRANSMITIR (9) na interface do
 *       RAMO (service-orders / orders — seed sql/59).
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
 *               orderId: { type: integer, description: id do pedido = id da nota }
 *     responses:
 *       201: { description: "{ ok, data: { invoiceId, attempt, dpsId, accessKey, nfseNumber, kind: 'A' } }" }
 *       400: { description: Payload inválido }
 *       403: { description: Sem privilégio TRANSMITIR (PRIVILEGE_REQUIRED) }
 *       404: { description: Nota não encontrada / não emitida por este estabelecimento }
 *       409: { description: FISCAL_ISSUER_MISSING · FISCAL_CERT_MISSING/EXPIRED · FISCAL_TRANSMISSION_IN_PROGRESS · FISCAL_ALREADY_AUTHORIZED · FISCAL_CANCEL_IN_FLIGHT · INVOICE_NOT_TRANSMITTABLE · FISCAL_AUTHORITY_AUTH_FAILED (F gravado) }
 *       422: { description: "INVOICE_SERVICE_BRANCH_MISSING · SERVICE_RULE_NATIONAL_CODE_REQUIRED · FISCAL_EMITTER_INCOMPLETE · FISCAL_RECIPIENT_INCOMPLETE · FISCAL_DPS_REJECTED (R gravado, E0xxx em fields[])" }
 *       502: { description: FISCAL_AUTHORITY_UNKNOWN_RESPONSE (ambíguo — nada gravado) }
 *       503: { description: FISCAL_AUTHORITY_UNAVAILABLE (ambíguo — tentativa em voo) }
 */
router.post('/transmit', requirePrivilegeFor(PRIVILEGE_TRANSMITIR, resolveFromBody), fiscal.transmit)

/**
 * @swagger
 * /api/billing/fiscal/transmit-batch:
 *   post:
 *     summary: Lote "Transmitir pendentes" (≤ 50 por requisição; nunca 500 por item)
 *     description: >-
 *       Uma transmissão por ordem, na sequência; cada item devolve ok/erro com
 *       código; TRANSMITIR conferido POR ITEM na interface do ramo. Fisco
 *       indisponível interrompe o lote (stoppedEarly, itens restantes retryable).
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderIds]
 *             properties:
 *               orderIds: { type: array, items: { type: integer }, minItems: 1, maxItems: 50 }
 *     responses:
 *       200: { description: "{ ok, data: { requested, transmitted, failed, stoppedEarly, results: [{ orderId, ok, attempt?, accessKey?, nfseNumber?, code?, error?, retryable? }] } } — orçamento de 60 s por lote (itens não processados voltam retryable)" }
 *       400: { description: Payload inválido }
 *       403: { description: Sem privilégio TRANSMITIR em nenhuma das interfaces do ramo }
 *       409: { description: FISCAL_BATCH_RUNNING — um lote por empresa de cada vez }
 */
router.post('/fiscal/transmit-batch', requirePrivilege(['service-orders', 'orders'], PRIVILEGE_TRANSMITIR), fiscal.transmitBatch)

/**
 * @swagger
 * /api/billing/fiscal/pending:
 *   get:
 *     summary: Notas de serviço sem transmissão vigente/autorizada (alimenta o lote)
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, default: 50, maximum: 200 } }
 *     responses:
 *       200: { description: "{ ok, data: [{ invoiceId, number, dtEmission }] }" }
 */
router.get('/fiscal/pending', fiscal.pending)

/**
 * @swagger
 * /api/billing/fiscal/refresh:
 *   post:
 *     summary: Consulta ativa das transmissões vivas (rodízio por last_queried_at)
 *     description: >-
 *       Uma passada por institution (duas telas = uma passada), orçamento de 20 s,
 *       para em fisco indisponível. Grava a voz (A/C) idempotente por (kind, dh);
 *       C do fisco produz o C local pela única porta de efeitos (SAVEPOINT — recusa
 *       de regra vira pendência visível).
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               minMinutes: { type: integer, default: 5 }
 *               limit: { type: integer, default: 8, maximum: 50 }
 *     responses:
 *       200: { description: "{ ok, data: { checked, changed, errors: [{ invoiceId, code, message }], stoppedEarly } }" }
 *       403: { description: Sem privilégio TRANSMITIR (D-N22 — quem consulta pode disparar efeito local) }
 */
// D-N22 (MEDIUM-7): consultar pode produzir efeito local (C) — exige TRANSMITIR do ramo
router.post('/fiscal/refresh', requirePrivilege(['service-orders', 'orders'], PRIVILEGE_TRANSMITIR), fiscal.refreshOpen)

/**
 * @swagger
 * /api/billing/fiscal/cancel:
 *   post:
 *     summary: Cancela a NFS-e NO FISCO (evento e101101) e, na mesma transação, a nota local
 *     description: >-
 *       Ordem da D-N7: (1) plano LOCAL (baixa/boleto/cheque/devolução bloqueiam
 *       ANTES do fisco — 409 INVOICE_CANCEL_BLOCKED); (2) estado fiscal — nunca
 *       transmitida/R/F cancela SÓ local; em voo → 409; K → 409; (3) prazo do PAM
 *       só como aviso em warnings[] (D-N15); (4) pedido assinado ao fisco fora da
 *       transação; (5) aceito → voz C + cancelInvoice na MESMA transação (recusa
 *       local no intervalo = pendência gravada, 409 FISCAL_EFFECT_PENDING); recusa
 *       do fisco → 409 FISCAL_CANCEL_REFUSED, nada muda; ambíguo → K em voo + 503.
 *       Privilégio CANCELAR (7) na interface do ramo.
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
 *               reason:  { type: string, maxLength: 255, description: vira xMotivo (15–255; curto ganha complemento padrão) }
 *     responses:
 *       200: { description: "{ ok, data: { invoiceId, attempt, atAuthority, invoiceEvent, transmissionEvent, warnings[] } }" }
 *       400: { description: Payload inválido / motivo ausente }
 *       403: { description: Sem privilégio CANCELAR }
 *       409: { description: INVOICE_CANCEL_BLOCKED · FISCAL_TRANSMISSION_IN_PROGRESS · FISCAL_CANCEL_IN_FLIGHT · FISCAL_CANCEL_REFUSED · FISCAL_EFFECT_PENDING · INVOICE_NOT_CANCELLABLE }
 *       503: { description: FISCAL_AUTHORITY_UNAVAILABLE — pedido enviado sem resposta (K gravado) }
 */
router.post('/fiscal/cancel', requirePrivilegeFor(PRIVILEGE_CANCELAR, resolveFromBody), fiscal.cancel)

/**
 * @swagger
 * /api/billing/fiscal/{orderId}/refresh:
 *   post:
 *     summary: Consulta o fisco sobre UMA nota (por dps_id ou chave) e grava a voz
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: orderId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { invoiceId, attempt, changed, kind, accessKey, invoiceEvent, effectRefused } }" }
 *       403: { description: Sem privilégio TRANSMITIR no ramo (D-N22) }
 *       409: { description: FISCAL_NOT_TRANSMITTED · FISCAL_ISSUER_MISSING · FISCAL_CERT_MISSING }
 *       502: { description: FISCAL_AUTHORITY_UNKNOWN_RESPONSE (nada gravado) }
 *       503: { description: FISCAL_AUTHORITY_UNAVAILABLE }
 */
router.post('/fiscal/:orderId/refresh', requirePrivilegeFor(PRIVILEGE_TRANSMITIR, resolveFromParam), fiscal.refreshOne)

/**
 * @swagger
 * /api/billing/fiscal/{orderId}:
 *   get:
 *     summary: Linha do tempo "No fisco" da nota de serviço
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: orderId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { invoiceId, state: none|in_flight|authorized|rejected|failed|cancelled|cancel_in_flight, transmissions[], events[], pendingEffects, xmlAvailable, danfseAvailable } }" }
 */
router.get('/fiscal/:orderId', requireInterfaceFor(resolveFromParam), fiscal.view)                 // Q-N32

/**
 * @swagger
 * /api/billing/fiscal/{orderId}/xml:
 *   get:
 *     summary: XML da NFS-e autorizada (do disco — nunca de coluna)
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: orderId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { accessKey, xml } }" }
 *       404: { description: FISCAL_NFSE_NOT_FOUND }
 */
router.get('/fiscal/:orderId/xml', requireInterfaceFor(resolveFromParam), fiscal.xml)              // Q-N32

/**
 * @swagger
 * /api/billing/fiscal/{orderId}/danfse:
 *   get:
 *     summary: DANFSe (PDF nosso, D-N13) da NFS-e autorizada
 *     tags: [billing]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: orderId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { accessKey, pdfBase64 } }" }
 *       404: { description: FISCAL_NFSE_NOT_FOUND }
 */
router.get('/fiscal/:orderId/danfse', requireInterfaceFor(resolveFromParam), fiscal.danfse)        // Q-N32

export default router
