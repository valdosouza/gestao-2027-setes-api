import { Router } from 'express'
import * as controller from './establishment.controller'

/**
 * Rotas do módulo establishment — montadas em /api/establishment pelo
 * gateway (adminGuard): permite ao ADMIN do próprio institution ler/editar
 * um SUBCONJUNTO RESTRITO da cadeia fiscal do PRÓPRIO estabelecimento.
 * NUNCA aceita :id de rota — o institutionId vem sempre do token
 * (IDOR eliminado por construção). Espelho no app: apps/web/lib/app/
 * modules/establishment/.
 *
 * document/personType (CPF/CNPJ e o toggle F/J) são SOMENTE LEITURA no
 * PUT: o cadastro completo com troca de documento continua exclusivo do
 * Super via /api/institutions/:id.
 */
const router = Router()

/**
 * @swagger
 * /api/establishment:
 *   get:
 *     summary: Retorna os dados do PRÓPRIO estabelecimento (institutionId do token — nunca de :id)
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: '{ ok: true, data: { nameCompany, nickTrade, document, personType, ie, im, taxRegime, addresses, phones, socials } }'
 *       401: { description: Não autenticado }
 *       403: { description: Restrito a administradores }
 *       500: { description: Erro interno }
 */
router.get('/', controller.get)

/**
 * @swagger
 * /api/establishment:
 *   put:
 *     summary: Atualiza o SUBCONJUNTO editável do próprio estabelecimento (document/personType são somente leitura — ignorados se enviados)
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nameCompany, nickTrade, ie, im, addresses, phones, socials]
 *             properties:
 *               nameCompany: { type: string, example: 'Fulano de Tal Ltda' }
 *               nickTrade:   { type: string, nullable: true, example: 'Fulano' }
 *               ie:          { type: string, nullable: true }
 *               im:          { type: string, nullable: true }
 *               taxRegime:
 *                 type: string
 *                 nullable: true
 *                 description: >-
 *                   Regime tributário do estabelecimento (D39 — rótulo canônico
 *                   de TAX_REGIMES; grava em tb_entity_tax do próprio emitente,
 *                   preservando os demais campos). Omitido = não toca.
 *                   D42 — troca de GRUPO (Simples 1/2 × Normal 3) REMOVE das
 *                   regras de tributação o código do regime antigo (indo p/
 *                   Simples zera o CST; p/ Normal zera o CSOSN): as regras
 *                   ficam pendentes no /billing/validate até serem revisadas.
 *                 example: '1 - Simples Nacional'
 *               addresses:
 *                 type: array
 *                 items: { type: object }
 *               phones:
 *                 type: array
 *                 items: { type: object }
 *               socials:
 *                 type: array
 *                 items: { type: object }
 *     responses:
 *       200: { description: '{ ok: true, data: EstablishmentDto }' }
 *       400: { description: Validação falhou }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito a administradores }
 *       500: { description: Erro interno }
 */
router.put('/', controller.update)

export default router
