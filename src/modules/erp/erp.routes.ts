import { Router, Request, Response } from 'express'

const router = Router()

/**
 * @swagger
 * /api/erp/status:
 *   get:
 *     summary: Status do módulo ERP
 *     tags: [ERP]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Módulo ERP está ativo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 module:
 *                   type: string
 *                   example: erp
 *                 institutionId:
 *                   type: number
 *                 message:
 *                   type: string
 *       401:
 *         description: JWT inválido
 *       403:
 *         description: Módulo não habilitado para esta institution
 */
router.get('/status', (req: Request, res: Response) => {
  res.json({
    ok:            true,
    module:        'erp',
    institutionId: req.institution?.institutionId,
    message:       'Módulo ERP ativo',
  })
})

export default router
