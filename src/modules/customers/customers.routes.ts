import { Router } from 'express'
import * as controller from './customers.controller'

const router = Router()

/**
 * @swagger
 * /api/customers/salesman-lookup:
 *   get:
 *     summary: Lookup de vendedores (lista de apoio do form de cliente)
 *     description: Decisão 11 da Fase 3 — padrão countries/states; o cadastro completo de vendedor fica para a onda 2.
 *     tags: [Customers]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, name }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/salesman-lookup', controller.salesmanLookup)

/**
 * @swagger
 * /api/customers/carrier-lookup:
 *   get:
 *     summary: Lookup de transportadoras (lista de apoio do form de cliente)
 *     description: Decisão 11 da Fase 3 — padrão countries/states; o cadastro completo de transportadora fica para a onda 2.
 *     tags: [Customers]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, name }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/carrier-lookup', controller.carrierLookup)

/**
 * @swagger
 * /api/customers:
 *   get:
 *     summary: Listar clientes da institution do usuário logado
 *     tags: [Customers]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome fantasia ou razão social
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { id, nickTrade, nameCompany, active }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Criar cliente (cadeia de entidade fiscal com REUSO por documento)
 *     description: >
 *       Fase 3 Entidade Única — o app NUNCA envia entityId (decisão 9): a API
 *       resolve pelo CPF/CNPJ dentro da transação; documento já conhecido
 *       REAPROVEITA a entity e atualiza a cadeia (last-write-wins, decisão 1).
 *       personType 'N' (sem documento) gera tb_no_doc com external_id UUID.
 *       Papel já existente nesta institution → 409 com o id no payload
 *       (decisão 2).
 *     tags: [Customers]
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
 *               addresses, phones, socialMedia) + campos do cliente
 *               (tbSalesmanId, tbCarrierId, creditStatus L|B, creditValue,
 *               wallet S|N — 'S' grava a forma de pagamento "Carteira"
 *               autocreate, multiplier, active) + aba Tributação aninhada em
 *               `tax` (consumer, taxRegime, byPassSt, indIeDest,
 *               issExigibilidade 01..07, issProcessNr, issRetido,
 *               issIndIncFiscal, autoSendInvoice, autoSendInvoiceJustXml —
 *               salva na MESMA transação; omitida = não tocar)
 *     responses:
 *       201: { description: 'Envelope { ok, data: { id, reused } }' }
 *       400: { description: Validação (erro por campo) }
 *       401: { description: Não autenticado }
 *       409: { description: 'Papel duplicado nesta institution (fields[0] = id) ou conflito de corrida' }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/customers/{id}:
 *   get:
 *     summary: Obter cliente completo (cadeia fiscal + campos do papel)
 *     tags: [Customers]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — CustomerFull (cadeia + salesmanName/carrierName)' }
 *       401: { description: Não autenticado }
 *       404: { description: Cliente não encontrado nesta institution }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Atualizar cliente (cadeia + campos do papel)
 *     description: Upgrade N→F/J permitido quando o documento é inédito; documento de outra entity → 409 (decisão 6 — sem merge).
 *     tags: [Customers]
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
 *       404: { description: Cliente não encontrado }
 *       409: { description: Documento pertence a outra entity }
 *       500: { description: Erro interno }
 *   delete:
 *     summary: Excluir cliente (soft delete do PAPEL — a entity permanece)
 *     tags: [Customers]
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
 *       404: { description: Cliente não encontrado }
 *       500: { description: Erro interno }
 */
router.get('/:id', controller.getById)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
