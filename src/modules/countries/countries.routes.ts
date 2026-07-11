import { Router } from 'express'
import * as controller from './countries.controller'

/**
 * Rotas do módulo countries — montadas em /api/super/countries pelo
 * gateway (área Super = prefixo + guard; "Super" não é módulo de código).
 * Espelho no app: apps/web/lib/app/modules/countries/countries_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/super/countries:
 *   get:
 *     summary: Lista países (filter?= busca por nome, máx. 200)
 *     tags: [Countries]
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/super/countries/{id}:
 *   get:
 *     summary: Retorna um país pelo id
 *     tags: [Countries]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/super/countries:
 *   post:
 *     summary: Cria um país (id = código mundial BACEN, informado pelo usuário; 409 se já existir)
 *     tags: [Countries]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/super/countries/{id}:
 *   put:
 *     summary: Atualiza um país (somente o nome — o id/código nunca muda)
 *     tags: [Countries]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/super/countries/{id}:
 *   delete:
 *     summary: Exclui logicamente um país (deleted='S')
 *     tags: [Countries]
 */
router.delete('/:id', controller.remove)

export default router
