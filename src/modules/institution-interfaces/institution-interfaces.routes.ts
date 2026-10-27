import { Router } from 'express'
import * as controller from './institution-interfaces.controller'

/**
 * Tela "Interfaces dos clientes" (D-PV11, 2026-10-18 — prompt_privilegios_interfaces.md §11): o vínculo estabelecimento × interfaces
 * de cada cliente, delegável pelo Super a usuário da Setes. Montada no gateway com a guarda DELEGADA (`gatedModule(...,
 * { delegatedSuper: true })`): GET → VISUALIZAR, PUT → ALTERAR da interface `institution-interfaces`, marcados pelo Super no cadastro
 * do usuário (até o admin da Setes precisa); o Super passa sempre.
 * D-PV34 (2026-10-20): a gravação é POR MARCA — `PUT /:id/interfaces/:interfaceId { linked }`; a lista inteira saiu.
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
 *     summary: Catálogo VENDÁVEL (kind T/R fora do grupo Super — D-PV35) com a marca de quais o estabelecimento tem
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
 *       403: { description: 'Sem a liberação do Super (VISUALIZAR), fora da Setes, ou o estabelecimento é a própria Setes (SETES_INTERFACES_SUPER_ONLY — D-PV38)' }
 *       404: { description: Estabelecimento não encontrado }
 */
router.get('/:id', controller.getOne)

/**
 * @swagger
 * /api/institution-interfaces/{id}/interfaces/{interfaceId}:
 *   put:
 *     summary: UMA marca do contrato (D-PV34) — concede ou revoga uma interface do estabelecimento; idempotente
 *     tags: [InstitutionInterfaces]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: interfaceId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [linked]
 *             properties:
 *               linked: { type: boolean, description: 'true concede, false revoga (soft)' }
 *     responses:
 *       200: { description: '{ ok, data: { interfaceId, linked, changed } } — linked = estado DEPOIS da marca; changed = false quando já estava assim' }
 *       400: { description: 'Corpo inválido, interface fora do catálogo, ou não vendável (INTERFACE_NOT_SELLABLE — D-PV35)' }
 *       403: { description: 'Sem a liberação do Super (ALTERAR), fora da Setes, ou o estabelecimento é a própria Setes (SETES_INTERFACES_SUPER_ONLY)' }
 *       404: { description: Estabelecimento não encontrado }
 *       409: { description: 'Revogar interface ESTRUTURAL pela porta delegada (INTERFACE_STRUCTURAL_LOCKED — D-PV35)' }
 */
router.put('/:id/interfaces/:interfaceId', controller.putLink)

export default router
