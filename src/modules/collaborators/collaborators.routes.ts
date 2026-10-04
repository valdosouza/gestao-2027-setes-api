import { Router } from 'express'
import * as controller from './collaborators.controller'

const router = Router()

/**
 * @swagger
 * /api/collaborators:
 *   get:
 *     summary: Listar colaboradores da institution do usuário logado
 *     tags: [Collaborators]
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
 *       - in: query
 *         name: criteria
 *         schema: { type: string }
 *         description: 'Pesquisa avançada (D-BA1) — JSON { chave: valor } com as chaves de GET /search-criteria; texto = contém, faixa = { from, to }, lookup = id, options = [valores], bool = true|false. Soma em E com filter. Desconhecida/malformada = 400 SEARCH_CRITERIA_INVALID; valor inválido = 422 SEARCH_CRITERION_INVALID com fields[]'
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, nickTrade, nameCompany, active }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Criar colaborador (cadeia de entidade fiscal com REUSO por documento)
 *     description: >
 *       Onda 2 da Entidade Única — mesmo fluxo do customers: o app NUNCA
 *       envia entityId; a API resolve pelo CPF/CNPJ dentro da transação
 *       (documento conhecido REAPROVEITA a entity, last-write-wins).
 *       personType 'N' (sem documento) gera tb_no_doc com external_id UUID.
 *       Papel já existente nesta institution → 409 com o id no payload.
 *     tags: [Collaborators]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: >
 *               Cadeia fiscal (entity, personType F/J/N, person|company,
 *               addresses, phones, socialMedia) + campos do colaborador
 *               (dtAdmission/dtResignation AAAA-MM-DD, salary, fathersName,
 *               mothersName, voteNumber, voteZone, voteSection,
 *               militaryCertificate, pis, active S|N)
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id, reused } }' }
 *       400: { description: Validação (erro por campo) }
 *       401: { description: Não autenticado }
 *       409: { description: 'Papel duplicado nesta institution (fields[0] = id) ou conflito de corrida' }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/collaborators/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de colaboradores
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       declarada no módulo, sem expressão SQL.
 *     tags: [Collaborators]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind (text|number|money|date|lookup|options|bool), labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', controller.searchCriteria)
router.post('/', controller.create)

/**
 * @swagger
 * /api/collaborators/{id}:
 *   get:
 *     summary: Obter colaborador completo (cadeia fiscal + campos do papel)
 *     tags: [Collaborators]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — CollaboratorFull' }
 *       401: { description: Não autenticado }
 *       404: { description: Colaborador não encontrado nesta institution }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualizar colaborador (cadeia + campos do papel)
 *     description: Upgrade N→F/J permitido quando o documento é inédito; documento de outra entity → 409 (sem merge).
 *     tags: [Collaborators]
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
 *           schema: { type: object }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: Validação }
 *       401: { description: Não autenticado }
 *       404: { description: Colaborador não encontrado }
 *       409: { description: Documento pertence a outra entity }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Excluir colaborador (soft delete do PAPEL — a entity permanece)
 *     tags: [Collaborators]
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
 *       404: { description: Colaborador não encontrado }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getById)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
