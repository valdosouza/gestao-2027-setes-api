import { Router } from 'express'
import * as controller from './cities.controller'

/**
 * Rotas do módulo cities — montadas em /api/super/cities pelo gateway.
 * Espelho no app: apps/web/lib/app/modules/cities/cities_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/super/cities:
 *   get:
 *     summary: Lista cidades (filter?= nome; stateId?= filtro por estado)
 *     tags: [Cities]
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/super/cities/{id}:
 *   get:
 *     summary: Retorna uma cidade pelo id
 *     tags: [Cities]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/super/cities:
 *   post:
 *     summary: Cria uma cidade (id = código IBGE do município, informado pelo usuário; 409 se já existir)
 *     tags: [Cities]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/super/cities/{id}:
 *   put:
 *     summary: Atualiza uma cidade
 *     tags: [Cities]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/super/cities/{id}:
 *   delete:
 *     summary: Exclui logicamente uma cidade (deleted='S')
 *     tags: [Cities]
 */
router.delete('/:id', controller.remove)

export default router
