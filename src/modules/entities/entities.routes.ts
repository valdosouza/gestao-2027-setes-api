import { Router } from 'express'
import { byDocument, getTax, putTax } from './entities.controller'

const router = Router()

/**
 * @swagger
 * /api/entities/by-document:
 *   get:
 *     summary: Buscar entidade pelo documento (CPF/CNPJ)
 *     description: >
 *       Prefill da Fase 3 (Entidade Única, decisões 3, 9 e 10) — ao sair do
 *       campo de documento, o app consulta aqui; se a entidade já existe em
 *       setes_central, recebe a cadeia completa (entity + fiscal + endereços
 *       + fones + redes sociais) e a lista informativa de papéis existentes
 *       (institution global; customer/salesman/carrier na institution do
 *       usuário logado). Aberto a qualquer usuário autenticado — o prefill
 *       compartilhado é a feature. A resolução definitiva acontece de novo
 *       dentro da transação do salvar (o app nunca envia entityId).
 *     tags: [Entities]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: personType
 *         required: true
 *         schema: { type: string, enum: [F, J] }
 *         description: F = busca por CPF (tb_person); J = busca por CNPJ (tb_company)
 *       - in: query
 *         name: doc
 *         required: true
 *         schema: { type: string }
 *         description: Documento SEM máscara (11 dígitos CPF / 14 dígitos CNPJ)
 *     responses:
 *       200:
 *         description: >
 *           Envelope { ok, data } — data.found=false quando o documento é
 *           inédito; found=true traz data.entity (cadeia completa) e
 *           data.roles (ex.: ["institution","customer"])
 *       400:
 *         description: personType inválido ou documento com dígito verificador errado
 *       401:
 *         description: Não autenticado
 *       500:
 *         description: Erro interno
 */
router.get('/by-document', byDocument)

/**
 * @swagger
 * /api/entities/{id}/tax:
 *   get:
 *     summary: Tributação da entidade na institution do usuário logado
 *     description: >
 *       Fase 3 Rodada 4 (decisões 14–17) — tributação por RELAÇÃO COMERCIAL
 *       (tb_entity_tax no schema do cliente, PK entity + institution).
 *       Qualquer entidade pode precisar de tributação para receber notas;
 *       os módulos de papel (customers) salvam a aba junto no próprio POST/PUT.
 *     tags: [Entities]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 'Envelope { ok, data } — EntityTaxRow ou null se nunca configurada' }
 *       401: { description: Não autenticado }
 *       404: { description: Entidade não encontrada }
 *       500: { description: Erro interno }
 *   put:
 *     summary: Gravar/atualizar a tributação da entidade (upsert)
 *     tags: [Entities]
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
 *             description: >
 *               consumer/issRetido/issIndIncFiscal S|N (radiobox), byPassSt/
 *               autoSendInvoice/autoSendInvoiceJustXml S|N (checkbox),
 *               taxRegime (dropdown canônico), indIeDest 1|2|9,
 *               issExigibilidade 01..07, issProcessNr (25)
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 *       400: { description: Validação (erro por campo) }
 *       401: { description: Não autenticado }
 *       404: { description: Entidade não encontrada }
 *       500: { description: Erro interno }
 */
router.get('/:id/tax', getTax)
router.put('/:id/tax', putTax)

export default router
