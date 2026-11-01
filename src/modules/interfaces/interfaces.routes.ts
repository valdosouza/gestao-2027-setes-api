import { Router } from 'express'
import * as controller from './interfaces.controller'

/**
 * Rotas do módulo interfaces — montadas em /api/interfaces pelo
 * gateway. Id gerado MAX+1 no backend; privilegeIds sincroniza
 * tb_interface_has_privilege. GET /api/core/menus NÃO é afetado.
 * Espelho no app: apps/web/lib/app/modules/interfaces/interfaces_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/interfaces:
 *   get:
 *     summary: Lista interfaces (com privilegeIds)
 *     tags: [Interfaces]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por description, i18n_key ou group_default
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
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, groupDefault, i18nKey, description, kind, position, privilegeIds }' }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito à equipe Setes }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/interfaces/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de interfaces
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       declarada no módulo, sem expressão SQL.
 *     tags: [Interfaces]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind (text|number|money|date|lookup|options|bool|federalId — prefixo da inscrição federal, D-CJ9), labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', controller.searchCriteria)

/**
 * @swagger
 * /api/interfaces/{id}:
 *   get:
 *     summary: Retorna uma interface pelo id (com privilegeIds)
 *     tags: [Interfaces]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/interfaces:
 *   post:
 *     summary: Cria uma interface (id gerado MAX+1 no backend) e grava os privilégios
 *     tags: [Interfaces]
 *     responses:
 *       400: { description: 'i18nKey fora da forma da rota (D-PV42 — chave técnica em inglês; começa por letra; minúsculas, dígitos e hífen)' }
 *       409:
 *         description: >-
 *           D-PV15 (Q-PV17): a mudança recriaria o C1 — INTERFACE_KEY_IN_USE (chave repetida em outra interface viva) ou
 *           CATALOG_PAIR_IN_USE (a tela nasce sem o VISUALIZAR — toda tela, inclusive do grupo Super, D-GE19);
 *           fields[] nomeia cada consumidor
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/interfaces/{id}:
 *   put:
 *     summary: Atualiza uma interface (o id nunca muda) e sincroniza os privilégios
 *     tags: [Interfaces]
 *     responses:
 *       400: { description: 'i18nKey fora da forma da rota (D-PV42)' }
 *       409:
 *         description: >-
 *           D-PV15 (Q-PV17) + D-PV42 (Q-PV50): INTERFACE_KEY_IN_USE — a i18nKey de interface existente NÃO se renomeia (identificador
 *           técnico — mudar é código + seed), tela do cliente que o código usa não vira recurso nem vai ao grupo Super, ou chave
 *           repetida em outra interface viva; CATALOG_PAIR_IN_USE — sairia do catálogo um par que o código opera (guarda por roteador,
 *           lista à mão — D-PV14), o VISUALIZAR de uma tela, o CONFIGURAR de interface com config/campo (D-PV25) ou um par reservado
 *           (D-PV51), inclusive pelo PUT sem privilegeIds; fields[] nomeia cada consumidor
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/interfaces/{id}:
 *   delete:
 *     summary: Exclui logicamente uma interface (deleted='S')
 *     tags: [Interfaces]
 *     responses:
 *       409: { description: 'D-PV15/D-PV42: INTERFACE_KEY_IN_USE — interface cuja chave o código usa (rota do app, config/campo, par operado ou reservado) não pode ser excluída' }
 */
router.delete('/:id', controller.remove)

// ---------------------------------------------------------------------
// Catálogo de CONFIGURAÇÕES da interface (Framework de Configurações,
// decisões 6 e 7): seção "Configurações" da tela de Interfaces (Super).
// Os VALORES do cliente ficam no módulo interface-configs (sem guard).
// ---------------------------------------------------------------------

/**
 * @swagger
 * /api/interfaces/{id}/configs:
 *   get:
 *     summary: Lista o catálogo de configurações da interface (tb_interface_has_config)
 *     tags: [Interfaces]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: '{ ok, data: [{ name, description, kind, options, defaultContent, scope }] }'
 *       404:
 *         description: Interface não encontrada
 */
router.get('/:id/configs', controller.listConfigs)

/**
 * @swagger
 * /api/interfaces/{id}/configs/{name}:
 *   put:
 *     summary: Cria/atualiza uma configuração do catálogo (upsert; ressuscita soft-deleted)
 *     tags: [Interfaces]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *         description: Chave snake_case minúscula (até 50 chars)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description, kind, defaultContent, scope]
 *             properties:
 *               description: { type: string, description: 'Obrigatória — é o que salva o suporte' }
 *               kind: { type: string, enum: [String, Integer, Float, Boolean, Date, Options] }
 *               options: { type: string, nullable: true, description: 'Lista fechada p/ Options: "A=Por item;B=Por total"' }
 *               defaultContent: { type: string, description: 'Padrão inicial do produto (validado contra o kind)' }
 *               scope: { type: string, enum: [I, U], description: 'U = admite override por usuário' }
 *     responses:
 *       200: { description: 'Configuração salva' }
 *       400: { description: 'name/kind/options/default inválidos' }
 *       404: { description: 'Interface não encontrada' }
 */
router.put('/:id/configs/:name', controller.putConfig)

/**
 * @swagger
 * /api/interfaces/{id}/configs/{name}:
 *   delete:
 *     summary: Exclui logicamente uma configuração do catálogo (deleted='S')
 *     description: D-PV65 — a ÚLTIMA config viva (sem campo no catálogo) leva junto o par (interface × CONFIGURAR), salvo se ele segue exigido
 *       (código, Configurações Gerais, reservado). `retiredConfigure` diz se o par saiu.
 *     tags: [Interfaces]
 *     responses:
 *       200: { description: 'Configuração removida — `{ ok: true, retiredConfigure: boolean }`' }
 *       404: { description: 'Interface ou configuração inexistente' }
 */
router.delete('/:id/configs/:name', controller.deleteConfig)

export default router
