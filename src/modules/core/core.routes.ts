import { Router, Request, Response } from 'express'
import { getInstitutionData } from './core.service'
import logger from '@shared/logger/logger'

const router = Router()

router.get('/info', async (req: Request, res: Response) => {
  try {
    const data = await getInstitutionData(req.institution!.schemaName)
    res.json({ ok: true, data })
  } catch (err) {
    logger.error('Erro em core/info', { err })
    res.status(500).json({ error: 'Erro interno' })
  }
})

export default router
