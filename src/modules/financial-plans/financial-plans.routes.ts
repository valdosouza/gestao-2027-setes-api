import { Router } from 'express'
import * as controller from './financial-plans.controller'

/**
 * Rotas do módulo financial-plans — montadas em /api/financial-plans.
 * Cadastro de CLIENTE em ÁRVORE (sem superGuard — escopo por institution
 * do JWT); gate técnico = flag 'financial-plans'.
 * Espelho no app: apps/web/lib/app/modules/financial_plans/.
 */
const router = Router()

/**
 * @swagger
 * /api/financial-plans:
 *   get:
 *     summary: Lista o plano de contas em ordem de ÁRVORE (posit_level materializado)
 *     description: Ordenada por posit_level — a sequência já é a da treeview; parentId derivado do caminho (null = raiz).
 *     tags: [FinancialPlans]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por descrição
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, description, positLevel, parentId, source, kind, cluster, active }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Cria uma conta (nível raiz ou subnível do parentId)
 *     description: >
 *       id gerado MAX+1 por institution; posit_level nasce na criação
 *       (caminho do pai + código — porta do reg_plano_contas.pas).
 *       Domínios (defaults do Delphi C/C/S): source = Natureza C(redora)/
 *       D(evedora); kind = Tipo C(entro de Custo)/R(esultado);
 *       cluster = Nível S(intética)/A(nalítica).
 *     tags: [FinancialPlans]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description]
 *             properties:
 *               description: { type: string }
 *               source: { type: string, enum: [C, D], description: 'Natureza: C Credora / D Devedora' }
 *               kind: { type: string, enum: [C, R], description: 'Tipo: C Centro de Custo / R Contas de Resultado' }
 *               cluster: { type: string, enum: [S, A], description: 'Nível: S Sintética / A Analítica' }
 *               parentId: { type: integer, nullable: true, description: 'null/omitido = nível raiz' }
 *               active: { type: string, enum: [S, N] }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: 'Validação (pai inexistente)' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/financial-plans/{id}:
 *   get:
 *     summary: Retorna uma conta pelo id (na institution do usuário)
 *     tags: [FinancialPlans]
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
 *       404: { description: Conta não encontrada }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualiza a conta e MOVE de pai quando parentId muda
 *     description: >
 *       parentId presente e diferente do atual = mover — a API recalcula o
 *       posit_level da SUBÁRVORE inteira em transação (proibido mover para
 *       si mesma/descendente).
 *     tags: [FinancialPlans]
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
 *               source: { type: string, enum: [C, D] }
 *               kind: { type: string, enum: [C, R] }
 *               cluster: { type: string, enum: [S, A] }
 *               parentId: { type: integer, nullable: true, description: 'null = raiz; omitido = não mover' }
 *               active: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: 'Validação (ciclo / pai inexistente)' }
 *       401: { description: Não autenticado }
 *       404: { description: Conta não encontrada }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Exclui logicamente uma conta (bloqueado se houver subníveis)
 *     tags: [FinancialPlans]
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
 *       404: { description: Conta não encontrada }
 *       409: { description: 'Conta possui subníveis — excluir os filhos primeiro' }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getById)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
