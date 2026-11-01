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
 *       - in: query
 *         name: criteria
 *         schema: { type: string }
 *         description: 'Pesquisa avançada (D-BA1) — JSON { chave: valor } com as chaves de GET /search-criteria; texto = contém, faixa = { from, to }, lookup = id, options = [valores], bool = true|false. Soma em E com filter. Desconhecida/malformada = 400 SEARCH_CRITERIA_INVALID; valor inválido = 422 SEARCH_CRITERION_INVALID com fields[]'
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, name, email, active, kind }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/users/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de usuários
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       sem expressão SQL. "institution" só para o Super (D-BA24); "kind" (perfil do vínculo)
 *       só com vínculo em foco — admin sempre, Super só com institutionId.
 *     tags: [Users]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: institutionId
 *         schema: { type: integer }
 *         description: Foco (super) — o mesmo da lista
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind, labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', controller.searchCriteria)

/**
 * @swagger
 * /api/users/institution-lookup:
 *   get:
 *     summary: Lookup de instituições do critério "instituição" (só Super)
 *     tags: [Users]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome/apelido
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, name }' }
 *       401: { description: Não autenticado }
 *       403: { description: Não é Super }
 *       500: { description: Erro interno }
 */
router.get('/institution-lookup', controller.institutionLookup)

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
 *     summary: Usuário completo (nome/apelido + email de login + ativo do VÍNCULO em foco — senha NUNCA sai)
 *     description: D-PV19/D-UC2 — `active` é o do vínculo com o estabelecimento em foco (admin = o do JWT; super = `?institutionId`; sem foco = null)
 *     tags: [Users]
 *     parameters:
 *       - in: query
 *         name: institutionId
 *         schema: { type: integer }
 *         description: Vínculo em foco (só o super escolhe)
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
 *     summary: Atualiza usuário (senha ausente/null mantém a atual; e-mail de login IMUTÁVEL; ativo = o vínculo com o estabelecimento alvo)
 *     description: >
 *       D-PV19 (D-UC1…D-UC3): o e-mail de login nunca muda (409 LOGIN_EMAIL_IMMUTABLE); `active` (opcional) grava
 *       `tb_institution_has_user.active` do vínculo com `institutionId` (só o super informa; o admin tem o alvo forçado ao JWT —
 *       sem alvo com `active` presente = 400); a conta do super só o Super altera (403 USER_MANAGED_BY_SUPER).
 *       A exclusão de usuário NÃO existe (a credencial nunca é excluída — inativa-se o vínculo).
 *     tags: [Users]
 */
router.put('/:id', controller.update)

export default router
