import { Router } from 'express'
import * as controller from './state-tax-rates.controller'

/**
 * Rotas do catálogo MVA/FCP por UF×NCM (/api/state-tax-rates/mva|fcp —
 * espelha /home/state-tax-rates). Cadastro de CLIENTE: sem superGuard;
 * gate técnico = flag 'state-tax-rates'. Sem tela no app ainda (Q22 —
 * onda do app desta fase); as funções de resolução (`resolveMvaAliq`/
 * `resolveFcpAliq`) são consumidas direto pela orquestração do faturamento.
 */
const router = Router()

/**
 * @swagger
 * /api/state-tax-rates/mva:
 *   get:
 *     summary: Lista paginada de alíquotas internas + MVA por UF×NCM
 *     description: >-
 *       Fonte do ICMS-ST/ICMS Simples (P2.7/P3.1 do tributacao.md) — match
 *       por IGUALDADE EXATA de NCM. Envelope { ok, data, page, pageSize, total }.
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: pageSize, schema: { type: integer } }
 *       - { in: query, name: filter, schema: { type: string } }
 *     responses:
 *       200: { description: "{ ok, data, page, pageSize, total }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag state-tax-rates desabilitada }
 *       500: { description: Erro interno }
 */
router.get('/mva', controller.listMvaHandler)

/**
 * @swagger
 * /api/state-tax-rates/mva/{id}:
 *   get:
 *     summary: Alíquota MVA por id
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data }" }
 *       404: { description: Não encontrada }
 */
router.get('/mva/:id', controller.getMvaHandler)

/**
 * @swagger
 * /api/state-tax-rates/mva:
 *   post:
 *     summary: Cria alíquota MVA (Estado + NCM únicos por institution)
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [stateId, ncm, internalAliq, mvaOriginal]
 *             properties:
 *               stateId: { type: integer }
 *               ncm: { type: string }
 *               internalAliq: { type: number }
 *               mvaOriginal: { type: number }
 *               mvaAdjusted: { type: number, nullable: true }
 *     responses:
 *       201: { description: "{ ok, data: { id } }" }
 *       400: { description: Payload inválido }
 *       409: { description: Estado + NCM já cadastrados }
 */
router.post('/mva', controller.createMvaHandler)

/**
 * @swagger
 * /api/state-tax-rates/mva/{id}:
 *   put:
 *     summary: Atualiza alíquota MVA
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { id } }" }
 *       404: { description: Não encontrada }
 *       409: { description: Estado + NCM já cadastrados }
 */
router.put('/mva/:id', controller.updateMvaHandler)

/**
 * @swagger
 * /api/state-tax-rates/mva/{id}:
 *   delete:
 *     summary: Exclui alíquota MVA (soft delete)
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { id } }" }
 *       404: { description: Não encontrada }
 */
router.delete('/mva/:id', controller.removeMvaHandler)

/**
 * @swagger
 * /api/state-tax-rates/fcp:
 *   get:
 *     summary: Lista paginada de alíquotas de FCP por UF×NCM
 *     description: >-
 *       Fonte do FCP próprio/ST (P7 do tributacao.md) — match por PREFIXO
 *       (NCM parcial casa por capítulo/posição; mais específico vence).
 *       Envelope { ok, data, page, pageSize, total }.
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: pageSize, schema: { type: integer } }
 *       - { in: query, name: filter, schema: { type: string } }
 *     responses:
 *       200: { description: "{ ok, data, page, pageSize, total }" }
 */
router.get('/fcp', controller.listFcpHandler)

/**
 * @swagger
 * /api/state-tax-rates/fcp/{id}:
 *   get:
 *     summary: Alíquota FCP por id
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data }" }
 *       404: { description: Não encontrada }
 */
router.get('/fcp/:id', controller.getFcpHandler)

/**
 * @swagger
 * /api/state-tax-rates/fcp:
 *   post:
 *     summary: Cria alíquota FCP (Estado + NCM únicos por institution)
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [stateId, ncm, aliq]
 *             properties:
 *               stateId: { type: integer }
 *               ncm: { type: string }
 *               aliq: { type: number }
 *     responses:
 *       201: { description: "{ ok, data: { id } }" }
 *       400: { description: Payload inválido }
 *       409: { description: Estado + NCM já cadastrados }
 */
router.post('/fcp', controller.createFcpHandler)

/**
 * @swagger
 * /api/state-tax-rates/fcp/{id}:
 *   put:
 *     summary: Atualiza alíquota FCP
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { id } }" }
 *       404: { description: Não encontrada }
 *       409: { description: Estado + NCM já cadastrados }
 */
router.put('/fcp/:id', controller.updateFcpHandler)

/**
 * @swagger
 * /api/state-tax-rates/fcp/{id}:
 *   delete:
 *     summary: Exclui alíquota FCP (soft delete)
 *     tags: [state-tax-rates]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { id } }" }
 *       404: { description: Não encontrada }
 */
router.delete('/fcp/:id', controller.removeFcpHandler)

export default router
