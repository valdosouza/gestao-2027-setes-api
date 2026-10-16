import { Router } from 'express'
import * as controller from './states.controller'

/**
 * Rotas do módulo states — montadas em /api/states pelo gateway.
 * Espelho no app: apps/web/lib/app/modules/states/states_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/states:
 *   get:
 *     summary: Lista estados da base central
 *     tags: [States]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome ou UF (abbreviation)
 *       - in: query
 *         name: countryId
 *         schema: { type: integer }
 *         description: Filtro por país
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
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, tbCountryId, abbreviation, name, aliquota, countryName }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/states/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de estados
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       declarada no módulo, sem expressão SQL.
 *     tags: [States]
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
 * /api/states/countries-lookup:
 *   get:
 *     summary: Lookup de países (critério "país" da pesquisa avançada)
 *     tags: [States]
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
router.get('/countries-lookup', controller.countriesLookup)

/**
 * @swagger
 * /api/states/{id}:
 *   get:
 *     summary: Retorna um estado pelo id
 *     tags: [States]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/states:
 *   post:
 *     summary: Cria um estado (id = código IBGE da UF, informado pelo usuário; 409 se já existir)
 *     tags: [States]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/states/{id}:
 *   put:
 *     summary: Atualiza um estado
 *     tags: [States]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/states/{id}:
 *   delete:
 *     summary: Exclui logicamente um estado (deleted='S')
 *     tags: [States]
 */
router.delete('/:id', controller.remove)

export default router
