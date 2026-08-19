import { Router } from 'express'
import * as controller from './cfop.controller'

/**
 * Rotas do módulo cfop — montadas em /api/cfop pelo gateway (superGuard
 * por módulo: catálogo CENTRAL de referência fiscal, mantido pela Setes).
 * Espelho no app: apps/web/lib/app/modules/cfop/cfop_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/cfop:
 *   get:
 *     summary: Lista CFOPs (filter?= código/descrição/resumida)
 *     tags: [Cfop]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, description, concise, register, way, jurisdiction, note, active }' }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito à equipe Setes }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Cria um CFOP (id = código fiscal informado pelo usuário; 409 se já existir)
 *     description: >
 *       Código imutável e nunca reaproveitado (409 mesmo com deleted='S' —
 *       padrão de código externo). way = Sentido E(ntrada)/S(aída);
 *       jurisdiction = Alçada E(stadual)/N(acional)/X(Exterior);
 *       register = inteiro livre; note = Aplicação (texto longo).
 *     tags: [Cfop]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, description]
 *             properties:
 *               id: { type: string, description: 'Código CFOP (dígitos e pontos, até 10)' }
 *               description: { type: string }
 *               concise: { type: string, nullable: true }
 *               register: { type: integer, nullable: true }
 *               way: { type: string, enum: [E, S] }
 *               jurisdiction: { type: string, enum: [E, N, X], nullable: true }
 *               note: { type: string, nullable: true }
 *               active: { type: string, enum: [S, N] }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: Validação (erro por campo) }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito à equipe Setes }
 *       409: { description: 'Código já utilizado (mesmo excluído)' }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/cfop/{id}:
 *   get:
 *     summary: Retorna um CFOP pelo código
 *     tags: [Cfop]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data }' }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito à equipe Setes }
 *       404: { description: CFOP não encontrado }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualiza um CFOP (o código nunca muda)
 *     tags: [Cfop]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: Validação }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito à equipe Setes }
 *       404: { description: CFOP não encontrado }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Exclui logicamente um CFOP (deleted='S'; o código não é reaproveitado)
 *     tags: [Cfop]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito à equipe Setes }
 *       404: { description: CFOP não encontrado }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getById)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
