import { Router } from 'express'
import * as controller from './institutions.controller'

/**
 * Rotas do módulo institutions — montadas em /api/institutions pelo gateway.
 * Espelho no app: apps/web/lib/app/modules/institutions/institutions_module.dart
 *
 * Cadastro de Estabelecimento com cadeia de entidade fiscal (skill
 * cadastro-entidade-fiscal.md). O POST absorveu o onboarding: cria a cadeia,
 * provisiona o schema do cliente e ativa a institution.
 */
const router = Router()

/**
 * @swagger
 * /api/institutions:
 *   get:
 *     summary: Lista estabelecimentos (filter?= nome fantasia / razão social / schema)
 *     tags: [Institutions]
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/institutions/fiscal-exists:
 *   get:
 *     summary: CPF/CNPJ já cadastrado? (verificação antecipada ao sair do campo — decisão 21 Fase 2)
 *     tags: [Institutions]
 *     parameters:
 *       - in: query
 *         name: cpf
 *         schema: { type: string }
 *         description: CPF com 11 dígitos, sem máscara (informe cpf OU cnpj)
 *       - in: query
 *         name: cnpj
 *         schema: { type: string }
 *         description: CNPJ com 14 dígitos, sem máscara
 *       - in: query
 *         name: ignoreId
 *         schema: { type: integer }
 *         description: Entity em edição (ignorada na checagem)
 *     responses:
 *       200:
 *         description: '{ ok: true, data: { exists: boolean } }'
 *       400:
 *         description: Parâmetros inválidos ou dígito verificador não confere
 */
router.get('/fiscal-exists', controller.fiscalExists)

/**
 * @swagger
 * /api/institutions/{id}:
 *   get:
 *     summary: Retorna o estabelecimento COMPLETO (entity + fiscal + endereços/fones/redes + institution)
 *     tags: [Institutions]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/institutions:
 *   post:
 *     summary: Cria estabelecimento (cadeia em transação única) + provisiona o schema; active='S' só se a migração passar
 *     tags: [Institutions]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/institutions/{id}:
 *   put:
 *     summary: Atualiza a cadeia do estabelecimento (schema_name é imutável)
 *     tags: [Institutions]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/institutions/{id}:
 *   delete:
 *     summary: Exclui logicamente o estabelecimento (deleted='S' — a cadeia entity permanece)
 *     tags: [Institutions]
 */
router.delete('/:id', controller.remove)

/**
 * @swagger
 * /api/institutions/{id}/sync-api-key:
 *   get:
 *     summary: Chave de sincronização do estabelecimento (tb_sync_api_key — X-Api-Key do Sincronizador)
 *     tags: [Institutions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: '{ ok: true, data: { apiKey, establishmentCode, active } | null }'
 *       404:
 *         description: Estabelecimento não encontrado
 */
router.get('/:id/sync-api-key', controller.getSyncKey)

/**
 * @swagger
 * /api/institutions/{id}/sync-api-key:
 *   post:
 *     summary: Gera a chave de sincronização (só quando não existe — 409 se já houver; troca é intervenção manual)
 *     tags: [Institutions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       201:
 *         description: '{ ok: true, data: { apiKey, establishmentCode, active } }'
 *       404:
 *         description: Estabelecimento não encontrado
 *       409:
 *         description: Chave já existe
 */
router.post('/:id/sync-api-key', controller.createSyncKey)

export default router
