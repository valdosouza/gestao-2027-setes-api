import { Router } from 'express'
import * as controller from './privileges.controller'

/**
 * Rotas do módulo privileges — montadas em /api/privileges pelo
 * gateway. A lista também alimenta os checkboxes da tela de Interfaces.
 * Espelho no app: apps/web/lib/app/modules/privileges/privileges_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/privileges:
 *   get:
 *     summary: Lista privilégios — cadastro e checkboxes da tela de Interfaces
 *     tags: [Privileges]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por description
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
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, description }' }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito à equipe Setes }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/privileges/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de privilégios
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       declarada no módulo, sem expressão SQL.
 *     tags: [Privileges]
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
 * /api/privileges/{id}:
 *   get:
 *     summary: Retorna um privilégio pelo id (404 se não existir ou excluído)
 *     tags: [Privileges]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/privileges:
 *   post:
 *     summary: Cria um privilégio (id gerado MAX+1 no backend)
 *     tags: [Privileges]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/privileges/{id}:
 *   put:
 *     summary: Atualiza um privilégio (somente a description — o id nunca muda)
 *     tags: [Privileges]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/privileges/{id}:
 *   delete:
 *     summary: Exclui logicamente um privilégio (deleted='S')
 *     tags: [Privileges]
 */
router.delete('/:id', controller.remove)

export default router
