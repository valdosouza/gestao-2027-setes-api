import { Router } from 'express'
import * as controller from './interfaces.controller'

/**
 * Rotas do módulo interfaces — montadas em /api/interfaces pelo
 * gateway. Id gerado MAX+1 no backend; privilegeIds sincroniza
 * tb_interface_has_privilege. GET /api/core/menus NÃO é afetado.
 * Espelho no app: apps/web/lib/app/modules/interfaces/interfaces_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/interfaces:
 *   get:
 *     summary: Lista interfaces (filter?= description/i18n_key/group_default, máx. 200) com privilegeIds
 *     tags: [Interfaces]
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/interfaces/{id}:
 *   get:
 *     summary: Retorna uma interface pelo id (com privilegeIds)
 *     tags: [Interfaces]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/interfaces:
 *   post:
 *     summary: Cria uma interface (id gerado MAX+1 no backend) e grava os privilégios
 *     tags: [Interfaces]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/interfaces/{id}:
 *   put:
 *     summary: Atualiza uma interface (o id nunca muda) e sincroniza os privilégios
 *     tags: [Interfaces]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/interfaces/{id}:
 *   delete:
 *     summary: Exclui logicamente uma interface (deleted='S')
 *     tags: [Interfaces]
 */
router.delete('/:id', controller.remove)

export default router
