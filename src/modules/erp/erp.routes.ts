import { Router, Request, Response } from 'express'

const router = Router()

router.get('/status', (req: Request, res: Response) => {
  res.json({
    ok:            true,
    module:        'erp',
    institutionId: req.institution?.institutionId,
    message:       'Módulo ERP ativo',
  })
})

export default router
