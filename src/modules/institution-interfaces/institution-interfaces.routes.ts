import { Router } from 'express'
import * as controller from './institution-interfaces.controller'

/**
 * Tela "Interfaces dos clientes" (D-PV11, 2026-10-18 — prompt_privilegios_interfaces.md §11): o vínculo estabelecimento × interfaces
 * de cada cliente, delegável pelo Super a usuário da Setes. Montada no gateway com a guarda DELEGADA (`gatedModule(...,
 * { delegatedSuper: true })`): GET → VISUALIZAR, PUT → ALTERAR da interface `institution-interfaces`, marcados pelo Super no cadastro
 * do usuário (até o admin da Setes precisa); o Super passa sempre.
 */
const router = Router()

/**
 * @swagger
 * /api/institution-interfaces:
 *   get:
 *     summary: Estabelecimentos clientes (lista paginada) — para o usuário liberado, sem a própria Setes
 *     tags: [InstitutionInterfaces]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data: [{ id, name, active }], page, pageSize, total }' }
 *       401: { description: Não autenticado }
 *       403: { description: 'Sem a liberação do Super (VISUALIZAR) ou fora da Setes' }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/institution-interfaces/{id}:
 *   get:
 *     summary: Catálogo de interfaces com a marca de quais o estabelecimento tem
 *     tags: [InstitutionInterfaces]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data: [{ id, description, groupDefault, kind, granted }] }' }
 *       400: { description: id inválido }
 *       403: { description: 'Sem a liberação do Super (VISUALIZAR) ou fora da Setes' }
 *       404: { description: Estabelecimento não encontrado }
 *   put:
 *     summary: Grava as interfaces do estabelecimento (lista completa — concede a lista, revoga as demais)
 *     tags: [InstitutionInterfaces]
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
 *             required: [interfaceIds]
 *             properties:
 *               interfaceIds: { type: array, items: { type: integer } }
 *     responses:
 *       200: { description: Gravado }
 *       400: { description: 'Corpo inválido ou interface fora do catálogo' }
 *       403: { description: 'Sem a liberação do Super (ALTERAR), fora da Setes, ou o estabelecimento é a própria Setes (SETES_INTERFACES_SUPER_ONLY)' }
 *       404: { description: Estabelecimento não encontrado }
 */
router.get('/:id', controller.getOne)
router.put('/:id', controller.update)

export default router
