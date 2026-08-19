import { Router } from 'express'
import * as controller from './tax-rules.controller'

/**
 * Rotas do cadastro tax-rules (/api/tax-rules — espelha /home/tax-rules).
 * Cadastro de CLIENTE: sem superGuard; gate técnico = flag 'tax-rules'.
 */
const router = Router()

/**
 * @swagger
 * /api/tax-rules:
 *   get:
 *     summary: Lista paginada de regras de tributação
 *     description: >-
 *       Seletor + flags de presença das peças (hasIcms/hasIcmsSt/hasIpi/
 *       hasPisCofins/hasIi). Filtro por NCM ou descrição do produto.
 *       Envelope { ok, data, page, pageSize, total }.
 *     tags: [tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: pageSize, schema: { type: integer } }
 *       - { in: query, name: filter, schema: { type: string } }
 *     responses:
 *       200: { description: "{ ok, data, page, pageSize, total }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag tax-rules desabilitada }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/tax-rules/catalogs:
 *   get:
 *     summary: Catálogos fiscais centrais para os combos do form
 *     description: >-
 *       CSTs (ICMS NR/SN, IPI, PIS, COFINS), modalidades de base (NR/ST) e
 *       desoneração — lookups de apoio (sem paginação, exceção D6).
 *     tags: [tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, data: { icmsNr, icmsSn, modBc, modBcSt, discharge, ipi, pis, cofins } }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag desabilitada }
 *       500: { description: Erro interno }
 */
router.get('/catalogs', controller.catalogs)

/**
 * @swagger
 * /api/tax-rules/{id}:
 *   get:
 *     summary: Regra completa (seletor + peças presentes)
 *     tags: [tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { selector, pieces } }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag desabilitada }
 *       404: { description: Regra não encontrada }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/tax-rules:
 *   post:
 *     summary: Cria regra (seletor + peças na mesma transação)
 *     description: >-
 *       PRESENÇA = incidência: peça omitida = tributo não definido; regra sem
 *       nenhuma peça é 422. CSTs/modBC validados contra os catálogos centrais
 *       (422 com fields[]). id = MAX+1 no backend. selector.direction (E/S) é
 *       OBRIGATÓRIO — sem coringa de sentido (decisão 35); CFOP informado
 *       precisa ter way concordante (422).
 *     tags: [tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [selector]
 *             properties:
 *               selector: { type: object, description: "direction (E/S) obrigatório — decisão 35" }
 *               icms: { type: object }
 *               icmsSt: { type: object }
 *               ipi: { type: object }
 *               pisCofins: { type: array, items: { type: object } }
 *               ii: { type: object }
 *     responses:
 *       201: { description: "{ ok, data: { id } }" }
 *       400: { description: Payload inválido }
 *       401: { description: Sem JWT }
 *       403: { description: Flag desabilitada }
 *       422: { description: CST inexistente ou regra sem peça }
 *       500: { description: Erro interno }
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/tax-rules/{id}:
 *   put:
 *     summary: Atualiza regra (seletor + ressincroniza peças)
 *     tags: [tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { id } }" }
 *       400: { description: Payload inválido }
 *       401: { description: Sem JWT }
 *       403: { description: Flag desabilitada }
 *       404: { description: Regra não encontrada }
 *       422: { description: CST inexistente ou regra sem peça }
 *       500: { description: Erro interno }
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/tax-rules/{id}:
 *   delete:
 *     summary: Exclui regra (soft delete do seletor + peças)
 *     tags: [tax-rules]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ ok, data: { id } }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag desabilitada }
 *       404: { description: Regra não encontrada }
 *       500: { description: Erro interno }
 */
router.delete('/:id', controller.remove)

export default router
