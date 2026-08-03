import { Router } from 'express'
import * as controller from './users.controller'

/**
 * Rotas do módulo users — montadas em /api/users pelo gateway (adminGuard,
 * workflow 2026-07-12): SUPER opera qualquer institution (aba Usuários do
 * Estabelecimento manda institutionId); ADMIN do cliente opera SÓ a própria
 * (escopo forçado no service — ele nunca escolhe nem enxerga outras).
 * Espelho no app: apps/web/lib/app/modules/users/
 *
 * O cadastro grava a cadeia do LOGIN (tb_entity + tb_user + email grupo 2)
 * e gerencia os vínculos com institutions (tb_institution_has_user — sem
 * vínculo ativo o login devolve 403).
 */
const router = Router()

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Lista usuários (filter?= nome/apelido/email; institutionId?= só super — admin é forçado à própria)
 *     tags: [Users]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *       - in: query
 *         name: institutionId
 *         schema: { type: integer }
 *         description: Escopo (super). Admin do cliente ignora — vale o JWT.
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, name, email, active, kind }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/users/{id}/institutions:
 *   get:
 *     summary: Todas as institutions + situação do vínculo do usuário (kind = perfil/role)
 *     tags: [Users]
 */
router.get('/:id/institutions', controller.listInstitutions)

/**
 * @swagger
 * /api/users/{id}/institutions:
 *   put:
 *     summary: Sincroniza os vínculos (concede a lista com kind, revoga as demais — soft)
 *     tags: [Users]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               links:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     institutionId: { type: integer }
 *                     kind: { type: string, description: "Perfil na institution (vira o role do JWT; 'super' só vale na institution 1)" }
 */
router.put('/:id/institutions', controller.putInstitutions)

/**
 * @swagger
 * /api/users/{id}/privileges:
 *   get:
 *     summary: Interfaces contratadas do institution alvo × privilégios do catálogo × concessão ao usuário (ACL — workflow 2026-07-12)
 *     tags: [Users]
 *     parameters:
 *       - in: query
 *         name: institutionId
 *         schema: { type: integer }
 *         description: Obrigatório para o super; admin do cliente é forçado ao JWT
 */
router.get('/:id/privileges', controller.getPrivileges)

/**
 * @swagger
 * /api/users/{id}/privileges/{interfaceId}:
 *   put:
 *     summary: Sincroniza os privilégios de UMA interface (concede a lista, revoga o resto; VISUALIZAR decide o menu do regular)
 *     tags: [Users]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               institutionId: { type: integer, nullable: true }
 *               privilegeIds:
 *                 type: array
 *                 items: { type: integer }
 */
router.put('/:id/privileges/:interfaceId', controller.putPrivileges)

/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Usuário completo (nome/apelido + email de login + ativo — senha NUNCA sai)
 *     tags: [Users]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: Cria usuário (cadeia do login em transação única; institutionId+kind opcionais criam o vínculo junto — admin do cliente tem o alvo forçado ao JWT)
 *     tags: [Users]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Atualiza usuário (senha ausente/null mantém a atual; troca de email sincroniza o vínculo grupo 2)
 *     tags: [Users]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Exclui logicamente o usuário (deleted='S' — a entity permanece)
 *     tags: [Users]
 */
router.delete('/:id', controller.remove)

export default router
