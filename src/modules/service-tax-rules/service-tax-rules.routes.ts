import { Router } from 'express'
import * as controller from './service-tax-rules.controller'

/**
 * Rotas do módulo service-tax-rules — /api/service-tax-rules (espelha
 * /home/service-tax-rules). Cadastro do CLIENTE (schema + institution do
 * JWT); gate técnico = flag 'service-tax-rules'. Regra de Tributação de
 * SERVIÇO (ISS): cidade de incidência × item LC 116 → alíquota + código
 * municipal (prompt_regra_tributacao_servico.md, D1–D14).
 */
const router = Router()

/**
 * @swagger
 * /api/service-tax-rules:
 *   get:
 *     summary: Lista paginada das regras de tributação de serviço da institution
 *     tags: [service-tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: LIKE em cidade, item e descrição do item
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, cityId, cityName, stateAbbreviation, serviceListId, serviceListDescription, localIncidence, aliq, municipalCode, active }], page, pageSize, total }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag desabilitada }
 *   post:
 *     summary: Cria regra (id MAX+1; 409 se já existe regra viva para cidade × item)
 *     tags: [service-tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cityId, serviceListId, aliq]
 *             properties:
 *               cityId:        { type: integer, description: Município de INCIDÊNCIA (D12) }
 *               serviceListId: { type: string, example: '1.02' }
 *               aliq:          { type: number, example: 5 }
 *               municipalCode: { type: string, nullable: true, maxLength: 20 }
 *               active:        { type: string, enum: [S, N], default: S }
 *     responses:
 *       201: { description: "{ ok, data: { id } }" }
 *       400: { description: Validação / cidade ou item inexistente }
 *       409: { description: SERVICE_TAX_RULE_DUPLICATE }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/service-tax-rules/service-list:
 *   get:
 *     summary: Lookup dos itens ATIVOS da Lista de Serviços (form da regra)
 *     tags: [service-tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description }] }" }
 */
router.get('/service-list', controller.serviceListLookup)

/**
 * @swagger
 * /api/service-tax-rules/{id}:
 *   get:
 *     summary: Regra por id
 *     tags: [service-tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok, data }" }
 *       404: { description: Não encontrada }
 *   put:
 *     summary: Atualiza regra (mesmas validações do POST)
 *     tags: [service-tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrada }
 *       409: { description: SERVICE_TAX_RULE_DUPLICATE }
 *   delete:
 *     summary: Exclui (soft delete) — 409 SERVICE_TAX_RULE_IN_USE se um serviço aponta a regra
 *     tags: [service-tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrada }
 *       409: { description: Em uso }
 */
router.get('/:id', controller.getOne)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
