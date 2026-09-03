import { Router } from 'express'
import * as controller from './service-list.controller'

/**
 * Rotas do módulo service-list — /api/service-list (espelha /home/service-list;
 * superGuard por módulo no gateway). Lista de Serviços da LC 116/2003 —
 * referência fiscal CENTRAL consumida pela regra de tributação de serviço
 * (prompt_regra_tributacao_servico.md D10/D12). id = o próprio item ('1.01').
 */
const router = Router()

/**
 * @swagger
 * /api/service-list:
 *   get:
 *     summary: Lista paginada dos itens da Lista de Serviços (LC 116)
 *     tags: [service-list]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: LIKE em id e description
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description, localIncidence, active }], page, pageSize, total }" }
 *       401: { description: Sem JWT }
 *       403: { description: Restrito ao super }
 *   post:
 *     summary: Cria item (id = item da lista 'N.NN', informado; 409 se já existir mesmo excluído)
 *     tags: [service-list]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, description]
 *             properties:
 *               id:             { type: string, example: '1.01' }
 *               description:    { type: string, maxLength: 255 }
 *               localIncidence: { type: string, enum: [P, E], default: P, description: "P = município do prestador; E = município da execução (exceções do art. 3º)" }
 *               active:         { type: string, enum: [S, N], default: S }
 *     responses:
 *       201: { description: "{ ok, data: { id } }" }
 *       400: { description: Validação falhou }
 *       409: { description: Item já cadastrado }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/service-list/{id}:
 *   get:
 *     summary: Item por código
 *     tags: [service-list]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, example: '7.02' }
 *     responses:
 *       200: { description: "{ ok, data }" }
 *       404: { description: Não encontrado }
 *   put:
 *     summary: Atualiza descrição/incidência/ativo (código imutável)
 *     tags: [service-list]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrado }
 *   delete:
 *     summary: Exclui (soft delete)
 *     tags: [service-list]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrado }
 */
router.get('/:id', controller.getOne)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
