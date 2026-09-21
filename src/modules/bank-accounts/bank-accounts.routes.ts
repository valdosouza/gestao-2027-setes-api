import { Router } from 'express'
import * as controller from './bank-accounts.controller'
import * as channel from './bank-accounts.channel.controller'
import { adminGuard } from '@gateway/admin.guard'

/**
 * Rotas do módulo bank-accounts — montadas em /api/bank-accounts.
 * Cadastro de CLIENTE, grupo Financeiro (sem superGuard — escopo por
 * institution do JWT); gate técnico = flag 'bank-accounts'.
 * Espelho no app: apps/web/lib/app/modules/bank_accounts/.
 */
const router = Router()

/**
 * @swagger
 * /api/bank-accounts:
 *   get:
 *     summary: Lista as contas bancárias da institution do usuário
 *     tags: [BankAccounts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por banco (nome/número) ou nº da conta
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, bankId, bankNumber, bankDescription, agency, agencyDv, number, numberDv, manager, limitValue }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Cria uma conta bancária (banco validado no catálogo central)
 *     description: >
 *       Módulo Software House (5.6 do prompt fechado). id MAX+1 por
 *       institution; tb_bank é catálogo CENTRAL compartilhado (DP2 — seed
 *       FEBRABAN sql/17). O movimento financeiro referencia a conta
 *       (statement.tb_bank_account_id: 0 = Caixa, > 0 = conta).
 *     tags: [BankAccounts]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bankId, agency, number]
 *             properties:
 *               bankId: { type: integer, description: 'Banco do catálogo central (lookup /banks)' }
 *               dtOpening: { type: string, nullable: true, example: '2026-07-19' }
 *               agency: { type: string, maxLength: 8 }
 *               agencyDv: { type: string, nullable: true, maxLength: 2 }
 *               number: { type: string, maxLength: 10, description: 'Número da conta' }
 *               numberDv: { type: string, nullable: true, maxLength: 2 }
 *               phone: { type: string, nullable: true, maxLength: 10 }
 *               manager: { type: string, nullable: true, maxLength: 25 }
 *               limitValue: { type: number, nullable: true }
 *               dtContract: { type: string, nullable: true }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: 'Validação / banco inexistente no catálogo' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/bank-accounts/banks:
 *   get:
 *     summary: Lookup do catálogo CENTRAL de bancos (FEBRABAN)
 *     tags: [BankAccounts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome ou número
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, number, description }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/banks', controller.banksLookup)

/**
 * @swagger
 * /api/bank-accounts/{id}:
 *   get:
 *     summary: Retorna a conta bancária pelo id
 *     tags: [BankAccounts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — conta completa (+ dtOpening, phone, dtContract)' }
 *       401: { description: Não autenticado }
 *       404: { description: Conta não encontrada }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualiza a conta bancária
 *     tags: [BankAccounts]
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
 *             required: [bankId, agency, number]
 *             properties:
 *               bankId: { type: integer }
 *               dtOpening: { type: string, nullable: true }
 *               agency: { type: string }
 *               agencyDv: { type: string, nullable: true }
 *               number: { type: string }
 *               numberDv: { type: string, nullable: true }
 *               phone: { type: string, nullable: true }
 *               manager: { type: string, nullable: true }
 *               limitValue: { type: number, nullable: true }
 *               dtContract: { type: string, nullable: true }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: 'Validação / banco inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: Conta não encontrada }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Exclui a conta bancária (soft delete)
 *     tags: [BankAccounts]
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
 *       404: { description: Conta não encontrada }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getOne)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

/**
 * @swagger
 * /api/bank-accounts/{id}/channel:
 *   get:
 *     tags: [BankAccounts]
 *     summary: Canal API da conta (Onda 2 — D-I3/D-I4) — configuração + PRESENÇA/validade dos segredos
 *     description: |
 *       "Esta conta corrente fala com o seu banco por API." 1 canal por conta
 *       (`tb_bank_account_channel`). Devolve `channel` (environment S/P, clientId,
 *       active, inboundToken), `secrets` (certificate/privateKey/clientSecret =
 *       presença; `certificateInfo` com validade lida do arquivo), `bankNumber`,
 *       `adapterSupported` (derivado do banco da conta) e `webhookPath`. Nunca
 *       devolve conteúdo de segredo.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data: { channel, secrets, bankNumber, adapterSupported, webhookPath } }' }
 *       404: { description: Conta não encontrada }
 *   put:
 *     tags: [BankAccounts]
 *     summary: Cria/altera o canal API da conta (admin)
 *     description: Banco sem adaptador → 422 BANK_CHANNEL_NO_ADAPTER. O `inboundToken` nasce uma vez (rotação é ato próprio).
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [environment]
 *             properties:
 *               environment: { type: string, enum: [S, P] }
 *               clientId: { type: string, nullable: true, maxLength: 100 }
 *               active: { type: string, enum: [S, N], default: S }
 *     responses:
 *       200: { description: 'Envelope { ok, data } (mesma forma do GET)' }
 *       403: { description: Só admin }
 *       422: { description: Banco sem adaptador }
 *   delete:
 *     tags: [BankAccounts]
 *     summary: Desativa (soft delete) o canal da conta (admin) — segredos ficam no cofre
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 */
router.get('/:id/channel', channel.getChannel)
router.put('/:id/channel', adminGuard, channel.putChannel)
router.delete('/:id/channel', adminGuard, channel.deleteChannel)

/**
 * @swagger
 * /api/bank-accounts/{id}/channel/secrets:
 *   put:
 *     tags: [BankAccounts]
 *     summary: Envia os segredos do canal — WRITE-ONLY (admin)
 *     description: |
 *       D-I3: certificado mTLS (PEM), chave privada (PEM) e client_secret vão para
 *       `SECRETS_PATH/<schema>/bank-account/<id>/<S|P>/…`, NUNCA para o banco de
 *       dados nem para o repositório. Cada campo é opcional (o que vier é gravado).
 *       A resposta só traz presença e validade — jamais o conteúdo.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               certificatePem: { type: string }
 *               privateKeyPem: { type: string }
 *               clientSecret: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } (forma do GET /channel)' }
 *       400: { description: PEM inválido }
 *       409: { description: Canal ainda não configurado }
 *   delete:
 *     tags: [BankAccounts]
 *     summary: Apaga os segredos do canal no cofre (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data }' }
 */
router.put('/:id/channel/secrets', adminGuard, channel.putSecrets)
router.delete('/:id/channel/secrets', adminGuard, channel.deleteSecrets)

/**
 * @swagger
 * /api/bank-accounts/{id}/channel/rotate-token:
 *   post:
 *     tags: [BankAccounts]
 *     summary: Gera novo token de entrada do webhook (admin) — a URL cadastrada no banco muda
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data } (forma do GET /channel)' }
 * /api/bank-accounts/{id}/channel/test:
 *   post:
 *     tags: [BankAccounts]
 *     summary: Prova de vida do canal — autentica no banco (token + mTLS) e lê o webhook cadastrado
 *     description: Não escreve nada no banco. Erros legíveis — BANK_CHANNEL_SECRET_MISSING, BANK_CHANNEL_CERT_EXPIRED, BANK_AUTH_FAILED, BANK_UNAVAILABLE.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data: { ok, webhook, environment } }' }
 *       409: { description: Canal/segredo/certificado/autenticação }
 *       503: { description: Banco indisponível }
 */
router.post('/:id/channel/rotate-token', adminGuard, channel.rotateToken)
router.post('/:id/channel/test', adminGuard, channel.test)   // gasta cota do banco: só admin (LOW-3 do gate, assunção Q-I7)

/**
 * @swagger
 * /api/bank-accounts/{id}/channel/webhook:
 *   get:
 *     tags: [BankAccounts]
 *     summary: Webhook cadastrado NO BANCO (estado remoto — nunca flag local)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data: { url, createdAt, updatedAt } | null }' }
 *   put:
 *     tags: [BankAccounts]
 *     summary: Cadastra/altera o webhook no banco (admin; Onda 4 — exige URL https pública)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [url], properties: { url: { type: string, format: uri } } }
 *     responses:
 *       200: { description: 'Envelope { ok, data }' }
 *   delete:
 *     tags: [BankAccounts]
 *     summary: Remove o webhook no banco (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 */
router.get('/:id/channel/webhook', channel.getWebhook)
router.put('/:id/channel/webhook', adminGuard, channel.putWebhook)
router.delete('/:id/channel/webhook', adminGuard, channel.deleteWebhook)

export default router
