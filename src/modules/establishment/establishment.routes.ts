import { Router } from 'express'
import * as controller from './establishment.controller'
import * as issuer from './establishment.issuer.controller'

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

// ---------------------------------------------------------------------------
// Sub-recurso EMISSOR FISCAL (Onda 3 NFS-e / NF-e — conceito A, migration 058):
// habilitação POR MODELO (SE · 55; 65 na onda do PDV) + certificado A1 ÚNICO do
// estabelecimento (D-N31; write-only, .pfx + senha → par PEM no cofre). adminGuard herdado do
// gateway; institution SEMPRE do token.
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/establishment/issuer:
 *   get:
 *     tags: [Establishment]
 *     summary: Habilitação do emissor fiscal do PRÓPRIO estabelecimento — linhas por modelo + situação do certificado A1 (único)
 *     description: |
 *       `enabled` é DERIVADO (D-E4): linha viva + par certificado/chave presente no cofre do
 *       estabelecimento + certificado vigente e não vencido. `authority` é derivada do modelo
 *       (SE → ADN/Sefin Nacional; 55/65 → SEFAZ). `certificate` traz só presença e metadados
 *       públicos do certificado (subject, issuer, validade, CNPJ do e-CNPJ) — nunca conteúdo.
 *       D-N31: o MESMO A1 serve a homologação (H) e a produção (P).
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: >-
 *           { ok: true, data: { issuers: [{ model: 'SE'|'55'|'65', environment: 'H'|'P', serie, enabled, authority: 'ADN'|'SEFAZ' }],
 *           certificate: { certificate, privateKey, certificateInfo: { subject, issuer, notBefore, notAfter, daysToExpire, expired, notYetValid, cnpj } | null } } }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito a administradores }
 */
router.get('/issuer', issuer.getIssuer)

/**
 * @swagger
 * /api/establishment/issuer/certificate:
 *   put:
 *     tags: [Establishment]
 *     summary: Envia o certificado digital A1 (.pfx + senha) do estabelecimento — WRITE-ONLY, um só para H e P
 *     description: |
 *       D-N5/D-N31: o PKCS#12 é aberto na requisição, o certificado FOLHA (o vigente, se houver
 *       mais de um da mesma chave) e a chave viram PEM, o par é validado (legível, chave casa com o
 *       certificado, vigente, não vencido, CNPJ do CN = CNPJ do estabelecimento — D-N29) e SÓ ENTÃO
 *       os dois arquivos vão para `SECRETS_PATH/<schema>/establishment/<institution>/P/`.
 *       A senha e o .pfx nunca são persistidos nem logados. O mesmo A1 serve a TODOS os modelos
 *       e aos dois ambientes do fisco. A resposta só traz presença e validade.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pfxBase64, password]
 *             properties:
 *               pfxBase64: { type: string, maxLength: 64000, description: 'Arquivo .pfx em base64' }
 *               password:  { type: string, maxLength: 200, description: 'Senha do PKCS#12 — só vive nesta requisição' }
 *     responses:
 *       200: { description: '{ ok: true, data: { certificate, privateKey, certificateInfo } }' }
 *       400: { description: 'FISCAL_CERT_INVALID — não é PKCS#12, senha errada ou par não fecha (field pfx)' }
 *       409: { description: 'FISCAL_CERT_EXPIRED — vencido · FISCAL_CERT_INVALID — ainda não vigente, CNPJ ≠ estabelecimento ou e-CPF (nada gravado)' }
 *   delete:
 *     tags: [Establishment]
 *     summary: Apaga o par certificado/chave do estabelecimento no cofre (as habilitações ficam, desabilitadas)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: '{ ok: true, data: { certificate: false, privateKey: false, certificateInfo: null } }' }
 */
router.put('/issuer/certificate', issuer.putCertificate)
router.delete('/issuer/certificate', issuer.deleteCertificate)

/**
 * @swagger
 * /api/establishment/issuer/{model}:
 *   put:
 *     tags: [Establishment]
 *     summary: Cria/altera a habilitação do emissor para um MODELO (ambiente + série)
 *     description: |
 *       Série normalizada sem zeros à esquerda; para SE (DPS) exige 1–49999. Mudar o AMBIENTE de
 *       uma linha SE com transmissão VIVA no ambiente atual (último evento inexistente ou fora de
 *       A/R/C/F) é recusado — 409 FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS no campo `environment`.
 *       Modelo 65 (NFC-e) ainda não é suportado: 422 FISCAL_MODEL_NOT_SUPPORTED.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: model, required: true, schema: { type: string, enum: [SE, '55', '65'] } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [environment, serie]
 *             properties:
 *               environment: { type: string, enum: [H, P] }
 *               serie:       { type: string, pattern: '^\d{1,5}$', example: '1' }
 *     responses:
 *       200: { description: 'Envelope { ok, data } (mesma forma do GET /issuer)' }
 *       400: { description: Validação falhou }
 *       409: { description: FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS }
 *       422: { description: 'FISCAL_MODEL_NOT_SUPPORTED ou série do DPS fora de 1–49999' }
 *   delete:
 *     tags: [Establishment]
 *     summary: Exclui (soft delete) a habilitação do MODELO — o certificado do ambiente FICA
 *     description: Transmissão viva (qualquer ambiente) prende a linha — 409. O certificado é do ambiente e serve aos outros modelos.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: model, required: true, schema: { type: string, enum: [SE, '55', '65'] } }
 *     responses:
 *       200: { description: 'Envelope { ok, data } (mesma forma do GET /issuer)' }
 *       404: { description: FISCAL_ISSUER_MISSING }
 *       409: { description: FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS }
 *       422: { description: FISCAL_MODEL_NOT_SUPPORTED }
 */
router.put('/issuer/:model', issuer.putIssuer)
router.delete('/issuer/:model', issuer.deleteIssuer)

export default router
