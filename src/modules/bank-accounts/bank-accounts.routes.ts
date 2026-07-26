import { Router } from 'express'
import * as controller from './bank-accounts.controller'

/**
 * Rotas do módulo bank-accounts — montadas em /api/bank-accounts.
 * Cadastro de CLIENTE, grupo Financeiro (sem superGuard — escopo por
 * institution do JWT); gate técnico = flag 'bank-accounts'.
 * Espelho no app: apps/web/lib/app/modules/bank_accounts/.
 */
const router = Router()

/**
 * @swagger
 * /api/bank-accounts:
 *   get:
 *     summary: Lista as contas bancárias da institution do usuário
 *     tags: [BankAccounts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por banco (nome/número) ou nº da conta
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, bankId, bankNumber, bankDescription, agency, agencyDv, number, numberDv, manager, limitValue }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Cria uma conta bancária (banco validado no catálogo central)
 *     description: >
 *       Módulo Software House (5.6 do prompt fechado). id MAX+1 por
 *       institution; tb_bank é catálogo CENTRAL compartilhado (DP2 — seed
 *       FEBRABAN sql/17). O movimento financeiro referencia a conta
 *       (statement.tb_bank_account_id: 0 = Caixa, > 0 = conta).
 *     tags: [BankAccounts]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bankId, agency, number]
 *             properties:
 *               bankId: { type: integer, description: 'Banco do catálogo central (lookup /banks)' }
 *               dtOpening: { type: string, nullable: true, example: '2026-07-19' }
 *               agency: { type: string, maxLength: 8 }
 *               agencyDv: { type: string, nullable: true, maxLength: 2 }
 *               number: { type: string, maxLength: 10, description: 'Número da conta' }
 *               numberDv: { type: string, nullable: true, maxLength: 2 }
 *               phone: { type: string, nullable: true, maxLength: 10 }
 *               manager: { type: string, nullable: true, maxLength: 25 }
 *               limitValue: { type: number, nullable: true }
 *               dtContract: { type: string, nullable: true }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: 'Validação / banco inexistente no catálogo' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/bank-accounts/banks:
 *   get:
 *     summary: Lookup do catálogo CENTRAL de bancos (FEBRABAN)
 *     tags: [BankAccounts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome ou número
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, number, description }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/banks', controller.banksLookup)

/**
 * @swagger
 * /api/bank-accounts/{id}:
 *   get:
 *     summary: Retorna a conta bancária pelo id
 *     tags: [BankAccounts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — conta completa (+ dtOpening, phone, dtContract)' }
 *       401: { description: Não autenticado }
 *       404: { description: Conta não encontrada }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualiza a conta bancária
 *     tags: [BankAccounts]
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
 *             required: [bankId, agency, number]
 *             properties:
 *               bankId: { type: integer }
 *               dtOpening: { type: string, nullable: true }
 *               agency: { type: string }
 *               agencyDv: { type: string, nullable: true }
 *               number: { type: string }
 *               numberDv: { type: string, nullable: true }
 *               phone: { type: string, nullable: true }
 *               manager: { type: string, nullable: true }
 *               limitValue: { type: number, nullable: true }
 *               dtContract: { type: string, nullable: true }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: 'Validação / banco inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: Conta não encontrada }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Exclui a conta bancária (soft delete)
 *     tags: [BankAccounts]
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
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getOne)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
