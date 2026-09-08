import { Router } from 'express'
import * as controller from './bank-charge-agreements.controller'

/**
 * Rotas do módulo bank-charge-agreements — montadas em
 * /api/bank-charge-agreements. Cadastro de CLIENTE, grupo Financeiro (sem
 * superGuard — escopo por institution do JWT); gate técnico = flag
 * 'bank-charge-agreements'. Espelho no app:
 * apps/web/lib/app/modules/bank_charge_agreements/.
 */
const router = Router()

/**
 * @swagger
 * /api/bank-charge-agreements:
 *   get:
 *     summary: Lista as carteiras de cobrança da institution
 *     tags: [BankChargeAgreements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por convênio ou banco
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, agreement, bankAccountId, bankAccountLabel, active, ourNumberNext }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Cria a carteira de cobrança
 *     description: >
 *       Contratação de cobrança com o banco (tb_bank_charge_agreement,
 *       renomeada de tb_bank_charge_slip — migration 039). O BOLETO congela
 *       estas taxas/instruções na emissão (@shared/bank-slip); `active`
 *       decide se a carteira entra no gate 0/1/n do faturamento automático
 *       (D18 do contrato financeiro). `protest='S'` exige `dayProtest`.
 *     tags: [BankChargeAgreements]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agreement, bankAccountId]
 *             properties:
 *               agreement: { type: string, maxLength: 30, description: 'Número do convênio' }
 *               bankAccountId: { type: integer, description: 'Conta de crédito (lookup /bank-accounts)' }
 *               active: { type: string, enum: [S, N], default: S }
 *               accept: { type: string, enum: [S, N], default: N }
 *               aliqDiscount: { type: number, nullable: true }
 *               aliqInterest: { type: number, nullable: true }
 *               aliqLate: { type: number, nullable: true }
 *               valueLateMin: { type: number, nullable: true }
 *               aliqFine: { type: number, nullable: true }
 *               valueFine: { type: number, nullable: true }
 *               valueRate: { type: number, nullable: true, description: 'Tarifa' }
 *               instruction: { type: string, nullable: true, maxLength: 500 }
 *               protest: { type: string, enum: [S, N], default: N }
 *               dayProtest: { type: integer, nullable: true }
 *               ourNumberNext: { type: integer, nullable: true, description: 'Próximo nosso número (NULL = sem faixa, usa o id do boleto)' }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id } }' }
 *       400: { description: 'Validação / conta bancária inexistente' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/bank-charge-agreements/bank-accounts:
 *   get:
 *     summary: Lookup das contas correntes da institution
 *     tags: [BankChargeAgreements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, label }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/bank-accounts', controller.bankAccountsLookup)

/**
 * @swagger
 * /api/bank-charge-agreements/{id}:
 *   get:
 *     summary: Retorna a carteira de cobrança pelo id
 *     tags: [BankChargeAgreements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — carteira completa' }
 *       401: { description: Não autenticado }
 *       404: { description: Carteira não encontrada }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualiza a carteira de cobrança
 *     tags: [BankChargeAgreements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: 'Validação / conta bancária inexistente' }
 *       401: { description: Não autenticado }
 *       404: { description: Carteira não encontrada }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Exclui a carteira de cobrança (soft delete)
 *     description: Boletos já emitidos preservam a referência (rastreio) e continuam íntegros.
 *     tags: [BankChargeAgreements]
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
 *       404: { description: Carteira não encontrada }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getOne)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
