import { Router } from 'express'
import * as controller from './states.controller'

/**
 * Rotas do módulo states — montadas em /api/super/states pelo gateway.
 * Espelho no app: apps/web/lib/app/modules/states/states_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/super/states:
 *   get:
 *     summary: Lista estados (filter?= nome/UF; countryId?= filtro por país)
 *     tags: [States]
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/super/states/{id}:
 *   get:
 *     summary: Retorna um estado pelo id
 *     tags: [States]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/super/states:
 *   post:
 *     summary: Cria um estado (id = código IBGE da UF, informado pelo usuário; 409 se já existir)
 *     tags: [States]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/super/states/{id}:
 *   put:
 *     summary: Atualiza um estado
 *     tags: [States]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/super/states/{id}:
 *   delete:
 *     summary: Exclui logicamente um estado (deleted='S')
 *     tags: [States]
 */
router.delete('/:id', controller.remove)

export default router
