import { Router } from 'express'
import * as controller from './payment-types.controller'

/**
 * Rotas do módulo payment-types — montadas em /api/payment-types.
 * Cadastro de CLIENTE, grupo Financeiro (sem superGuard — escopo por
 * institution do JWT); gate técnico = flag 'payment-types'.
 * Espelho no app: apps/web/lib/app/modules/payment_types/.
 */
const router = Router()

/**
 * @swagger
 * /api/payment-types:
 *   get:
 *     summary: Lista as formas de pagamento VINCULADAS à institution do usuário
 *     tags: [PaymentTypes]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por descrição da forma
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, description, idNfce, enable, appMobile, blockForCustomerBlocked, blockForCustomerNoLimit, maxParcels, tef, financialPlansIdCre, financialPlansIdDeb, financialPlanCreDescription, financialPlanDebDescription }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Vincula uma forma do catálogo OU cria/reusa pela descrição
 *     description: >
 *       Workflow do Valdo — o CLIENTE inicia o cadastro: com paymentTypeId
 *       apenas vincula a forma existente; sem paymentTypeId a API procura a
 *       DESCRIÇÃO no catálogo central DENTRO da transação (existente =
 *       reusa/vincula, reused=true; inédita = cria com id MAX+1 e vincula —
 *       fica reutilizável pelos demais clientes). description/idNfce são
 *       imutáveis depois de criados (linha compartilhada). Os atributos do
 *       vínculo (enable, appMobile, bloqueios, maxParcels, tef, planos de
 *       conta) acompanham o POST e têm defaults.
 *     tags: [PaymentTypes]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paymentTypeId: { type: integer, nullable: true, description: 'Vincular forma existente do catálogo' }
 *               description: { type: string, nullable: true, description: 'Criar/reusar pela descrição (obrigatória sem paymentTypeId)' }
 *               idNfce: { type: string, nullable: true, description: 'Código de pagamento da NF-e (2 dígitos — lista fiscal fixa, combobox no app)' }
 *               enable: { type: string, enum: [S, N], description: 'Forma habilitada (o cliente desabilita por um tempo — não exclui a linha compartilhada)' }
 *               appMobile: { type: string, enum: [S, N], description: 'Disponível no app mobile' }
 *               blockForCustomerBlocked: { type: string, enum: [S, N], description: 'Não mostrar para clientes bloqueados' }
 *               blockForCustomerNoLimit: { type: string, enum: [S, N], description: 'Bloquear para clientes sem limite de crédito' }
 *               maxParcels: { type: integer, description: 'Número máximo de parcelas (default 1)' }
 *               tef: { type: string, enum: [S, N], description: 'Usa TEF — Transferência Eletrônica de Fundos' }
 *               financialPlansIdCre: { type: integer, description: 'Plano de Contas — Resultado (0 = não definido)' }
 *               financialPlansIdDeb: { type: integer, description: 'Plano de Contas — Centro de Custo (0 = não definido)' }
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id, reused } } — reused=true quando a forma já existia no catálogo' }
 *       400: { description: 'Validação / forma inexistente' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/payment-types/catalog:
 *   get:
 *     summary: Catálogo CENTRAL de formas (lookup do form), marcando as já vinculadas
 *     tags: [PaymentTypes]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por descrição
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, description, idNfce, linked }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/catalog', controller.catalog)

/**
 * @swagger
 * /api/payment-types/{id}:
 *   put:
 *     summary: Atualiza o VÍNCULO (atributos operacionais) e, se enviado, o código NF-e da linha central
 *     description: >
 *       idNfce é opcional — quando presente atualiza a linha COMPARTILHADA
 *       do catálogo central (vale para todos os clientes vinculados);
 *       null = sem código. A descrição permanece imutável (chave do reuso).
 *     tags: [PaymentTypes]
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
 *             properties:
 *               idNfce: { type: string, nullable: true, description: 'Código NF-e (2 dígitos, lista fiscal fixa); omitido = não mexer' }
 *               enable: { type: string, enum: [S, N] }
 *               appMobile: { type: string, enum: [S, N] }
 *               blockForCustomerBlocked: { type: string, enum: [S, N] }
 *               blockForCustomerNoLimit: { type: string, enum: [S, N] }
 *               maxParcels: { type: integer }
 *               tef: { type: string, enum: [S, N] }
 *               financialPlansIdCre: { type: integer }
 *               financialPlansIdDeb: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: Validação }
 *       401: { description: Não autenticado }
 *       404: { description: Forma não vinculada a este estabelecimento }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Desvincula a forma (soft delete do vínculo — o catálogo permanece)
 *     tags: [PaymentTypes]
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
 *       404: { description: Forma não vinculada }
 *       500: { description: Erro interno }
 */
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
