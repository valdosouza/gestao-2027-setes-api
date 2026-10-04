import { Router } from 'express'
import * as controller from './cities.controller'

/**
 * Rotas do módulo cities — montadas em /api/cities pelo gateway.
 * Espelho no app: apps/web/lib/app/modules/cities/cities_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/cities:
 *   get:
 *     summary: Lista cidades da base central
 *     tags: [Cities]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome
 *       - in: query
 *         name: stateId
 *         schema: { type: integer }
 *         description: Filtro por estado
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
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, tbStateId, ibge, name, population, density, area, stateName }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/cities/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de cidades
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       declarada no módulo, sem expressão SQL.
 *     tags: [Cities]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind (text|number|money|date|lookup|options|bool), labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', controller.searchCriteria)

/**
 * @swagger
 * /api/cities/states-lookup:
 *   get:
 *     summary: Lookup de estados (critério "estado" da pesquisa avançada)
 *     tags: [Cities]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, name }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/states-lookup', controller.statesLookup)

/**
 * @swagger
 * /api/cities/{id}:
 *   get:
 *     summary: Retorna uma cidade pelo id
 *     tags: [Cities]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/cities:
 *   post:
 *     summary: Cria uma cidade (id = código IBGE do município, informado pelo usuário; 409 se já existir)
 *     tags: [Cities]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/cities/{id}:
 *   put:
 *     summary: Atualiza uma cidade
 *     tags: [Cities]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/cities/{id}:
 *   delete:
 *     summary: Exclui logicamente uma cidade (deleted='S')
 *     tags: [Cities]
 */
router.delete('/:id', controller.remove)

export default router
