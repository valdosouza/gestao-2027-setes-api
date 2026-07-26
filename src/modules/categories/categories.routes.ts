import { Router } from 'express'
import * as controller from './categories.controller'

/**
 * Rotas do módulo categories — montadas em /api/categories pelo gateway.
 * Cadastro de CLIENTE (sem superGuard — escopo por institution do JWT);
 * gate técnico = flag 'categories'.
 * Espelho no app: apps/web/lib/app/modules/categories/categories_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/categories:
 *   get:
 *     summary: Lista categorias em ordem de ÁRVORE (posit_level materializado)
 *     description: Ordenada por posit_level — a sequência já é a da treeview; parentId derivado do caminho (null = raiz).
 *     tags: [Categories]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: kind
 *         schema: { type: string, enum: [P, S] }
 *         description: Árvore desejada (P = produtos, S = serviços; abas do app)
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por descrição
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, description, positLevel, parentId, kind, active }' }
 *       400: { description: kind inválido }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Cria uma categoria (nível raiz ou subnível do parentId)
 *     description: >
 *       id gerado MAX+1 por institution; posit_level nasce na criação
 *       (caminho do pai + código com 3 dígitos — porta do reg_category.pas).
 *       kind define a árvore e é IMUTÁVEL; o pai precisa ser do mesmo kind.
 *     tags: [Categories]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description, kind]
 *             properties:
 *               description: { type: string }
 *               kind: { type: string, enum: [P, S], description: 'P = produtos, S = serviços (árvore)' }
 *               parentId: { type: integer, nullable: true, description: 'null/omitido = nível raiz' }
 *               active: { type: string, enum: [S, N] }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: 'Validação (pai inexistente / de outro kind)' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/categories/{id}:
 *   get:
 *     summary: Retorna uma categoria pelo id (na institution do usuário)
 *     tags: [Categories]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data }' }
 *       401: { description: Não autenticado }
 *       404: { description: Categoria não encontrada }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualiza descrição/ativo e MOVE de pai quando parentId muda
 *     description: >
 *       parentId presente e diferente do atual = mover — a API recalcula o
 *       posit_level da SUBÁRVORE inteira em transação (proibido mover para
 *       si mesma/descendente ou para pai de outro kind). kind não muda.
 *     tags: [Categories]
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
 *             required: [description]
 *             properties:
 *               description: { type: string }
 *               parentId: { type: integer, nullable: true, description: 'null = raiz; omitido = não mover' }
 *               active: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: 'Validação (ciclo / pai inexistente / outro kind)' }
 *       401: { description: Não autenticado }
 *       404: { description: Categoria não encontrada }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Exclui logicamente uma categoria (bloqueado se houver subníveis)
 *     tags: [Categories]
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
 *       404: { description: Categoria não encontrada }
 *       409: { description: 'Categoria possui subníveis — excluir os filhos primeiro' }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getById)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
