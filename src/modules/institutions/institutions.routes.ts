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

export default router
