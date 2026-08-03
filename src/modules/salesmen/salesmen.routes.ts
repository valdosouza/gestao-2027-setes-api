import { Router } from 'express'
import * as controller from './salesmen.controller'

const router = Router()

/**
 * @swagger
 * /api/salesmen:
 *   get:
 *     summary: Listar vendedores da institution do usuário logado
 *     tags: [Salesmen]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome fantasia ou razão social
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, nickTrade, nameCompany, active }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Promover colaborador a vendedor (D1 — precedência por construção)
 *     description: >
 *       Onda 2 da Entidade Única — o vendedor NASCE de um colaborador desta
 *       institution (id vem do lookup /api/salesmen/collaborator-lookup); a
 *       cadeia fiscal NÃO é editada aqui. Colaborador inexistente → 404;
 *       colaborador que já é vendedor → 409 DUP_ROLE com o id no payload
 *       (o app abre a edição); papel soft-deletado REVIVE com os dados novos.
 *     tags: [Salesmen]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id]
 *             properties:
 *               id:              { type: integer, description: 'Id do colaborador promovido' }
 *               active:          { type: string, enum: [S, N], default: S }
 *               aliqKickback:    { type: number, nullable: true, description: 'Percentual de comissão (0..100)' }
 *               kickbackProduct: { type: string, enum: [S, N], nullable: true, description: 'Comissão sobre produto' }
 *               flexValue:       { type: number, default: 0 }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: Validação (erro por campo) }
 *       401: { description: Não autenticado }
 *       404: { description: Colaborador não encontrado nesta institution }
 *       409: { description: 'Colaborador já é vendedor (fields[0] = id) ou conflito de corrida' }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/salesmen/collaborator-lookup:
 *   get:
 *     summary: Lookup de colaboradores para a promoção (origem do "novo vendedor" — D1)
 *     tags: [Salesmen]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome fantasia ou razão social
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, name } (máx. 50)' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/collaborator-lookup', controller.collaboratorLookup)

/**
 * @swagger
 * /api/salesmen/{id}:
 *   get:
 *     summary: Obter vendedor (identificação do colaborador readonly + campos do papel)
 *     tags: [Salesmen]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — { id, nickTrade, nameCompany, document, active, aliqKickback, kickbackProduct, flexValue }' }
 *       401: { description: Não autenticado }
 *       404: { description: Vendedor não encontrado nesta institution }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualizar campos do papel de vendedor
 *     tags: [Salesmen]
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
 *               active:          { type: string, enum: [S, N] }
 *               aliqKickback:    { type: number, nullable: true }
 *               kickbackProduct: { type: string, enum: [S, N], nullable: true }
 *               flexValue:       { type: number }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: Validação }
 *       401: { description: Não autenticado }
 *       404: { description: Vendedor não encontrado }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Excluir vendedor (soft delete LIVRE — D4; carteira vira histórico)
 *     tags: [Salesmen]
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
 *       404: { description: Vendedor não encontrado }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getById)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
