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
 *         description: '{ ok: true, data: { nameCompany, nickTrade, document, personType, ie, im, taxRegime, simplesRegime, simplesAssessment, simplesTotalTaxAliquot, specialTaxRegime, cnae, addresses, phones, socials } }'
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
 *               simplesRegime:     { type: string, nullable: true, enum: ['1', '2', '3'], description: 'opSimpNac do DPS — 1 não optante · 2 MEI · 3 ME/EPP' }
 *               simplesAssessment: { type: string, nullable: true, enum: ['1', '2', '3'], description: 'regApTribSN — obrigatório com simplesRegime 3 (Q-N36; 422 REQUIRED_FIELDS no estado resultante)' }
 *               simplesTotalTaxAliquot: { type: number, nullable: true, minimum: 0.01, maximum: 99.99, example: 6.00, description: 'pTotTribSN — % aproximado da alíquota efetiva do Simples (DAS); obrigatório com simplesRegime 3 (Q-N37); sair do regime 3 limpa' }
 *               specialTaxRegime:  { type: string, nullable: true, enum: ['0', '1', '2', '3', '4', '5', '6'] }
 *               cnae:              { type: string, nullable: true, pattern: '^\d{7}$' }
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

// ---------------------------------------------------------------------------
// Sub-recurso EMISSOR FISCAL (Onda 3 NFS-e / NF-e — conceito A, migration 058):
// habilitação POR MODELO (SE · 55; 65 na onda do PDV) + certificado A1 ÚNICO do
// estabelecimento (D-N31; write-only, .pfx + senha → par PEM no cofre). adminGuard herdado do
// gateway; institution SEMPRE do token.
// ---------------------------------------------------------------------------

// F2a, etapa A3 (D-F4/D-F12/D-F112): as 5 rotas do EMISSOR fiscal (habilitação por modelo e A1) MORRERAM — o app fala com a
// nfse-api direto (`/v1/emitter/*`; A1 cifrado no fiscal_api — D-F16). A SÉRIE da nota por modelo é leitura só no ERP
// (`@shared/invoice-series`), sem tela até o 1º cliente de mercadoria.

export default router
