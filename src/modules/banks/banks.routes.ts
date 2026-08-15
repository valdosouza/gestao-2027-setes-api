import { Router } from 'express'
import * as controller from './banks.controller'

/**
 * Rotas do módulo banks — montadas em /api/banks pelo gateway (superGuard
 * por módulo; "Super" é só agrupador de menu, nunca código/URL). Catálogo
 * FEBRABAN central (decisão do Valdo 2026-08-04): a manutenção é do Super;
 * o CONSUMO pelos clientes segue no lookup /api/bank-accounts/banks.
 * Espelho no app: apps/web/lib/app/modules/banks/banks_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/banks:
 *   get:
 *     summary: Lista bancos do catálogo central (FEBRABAN)
 *     tags: [Banks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por número ou descrição
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, number, description }' }
 *       401: { description: Não autenticado }
 *       403: { description: Acesso restrito à equipe Setes }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/banks/{id}:
 *   get:
 *     summary: Retorna um banco pelo id
 *     tags: [Banks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: '{ ok, data: { id, number, description } }' }
 *       404: { description: Banco não encontrado }
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/banks:
 *   post:
 *     summary: Cria um banco (id interno MAX+1; número FEBRABAN de 3 dígitos, único — 409 se VIVO; número de banco excluído REVIVE a mesma linha com o id preservado)
 *     tags: [Banks]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [number, description]
 *             properties:
 *               number:      { type: string, example: '341' }
 *               description: { type: string, example: 'Itaú Unibanco' }
 *     responses:
 *       201: { description: '{ ok, data: { id } }' }
 *       400: { description: Payload inválido }
 *       409: { description: Número FEBRABAN já cadastrado }
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/banks/{id}:
 *   put:
 *     summary: Atualiza um banco (número e descrição — o número mantém a unicidade; o id nunca muda)
 *     tags: [Banks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: '{ ok: true }' }
 *       404: { description: Banco não encontrado }
 *       409: { description: Número FEBRABAN já cadastrado }
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/banks/{id}:
 *   delete:
 *     summary: Exclui logicamente um banco (deleted='S'; bloqueado se em uso por conta corrente de qualquer cliente)
 *     tags: [Banks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: '{ ok: true }' }
 *       404: { description: Banco não encontrado }
 *       409: { description: 'Banco em uso por conta corrente (code BANK_IN_USE) — exclusão bloqueada' }
 */
router.delete('/:id', controller.remove)

export default router
