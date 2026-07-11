import { Router } from 'express'
import * as controller from './privileges.controller'

/**
 * Rotas do módulo privileges — montadas em /api/super/privileges pelo
 * gateway. A lista também alimenta os checkboxes da tela de Interfaces.
 * Espelho no app: apps/web/lib/app/modules/privileges/privileges_module.dart
 */
const router = Router()

/**
 * @swagger
 * /api/super/privileges:
 *   get:
 *     summary: Lista privilégios (filter?= description) — cadastro e checkboxes da tela de Interfaces
 *     tags: [Privileges]
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/super/privileges/{id}:
 *   get:
 *     summary: Retorna um privilégio pelo id (404 se não existir ou excluído)
 *     tags: [Privileges]
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/super/privileges:
 *   post:
 *     summary: Cria um privilégio (id gerado MAX+1 no backend)
 *     tags: [Privileges]
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/super/privileges/{id}:
 *   put:
 *     summary: Atualiza um privilégio (somente a description — o id nunca muda)
 *     tags: [Privileges]
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/super/privileges/{id}:
 *   delete:
 *     summary: Exclui logicamente um privilégio (deleted='S')
 *     tags: [Privileges]
 */
router.delete('/:id', controller.remove)

export default router
