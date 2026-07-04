import { Router, Request, Response } from 'express'

const router = Router()

router.get('/', (req: Request, res: Response) => {
  res.json({ ok: true, module: 'template' })
})

export default router
