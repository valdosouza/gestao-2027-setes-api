import { Router, Request, Response } from 'express'
import { login, selectInstitution, switchInstitution, recoveryPassword, changePassword } from './auth.service'
import { authMiddleware } from '@gateway/auth.middleware'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

function fail(res: Response, err: unknown, context: string) {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message })
    return
  }
  logger.error(`Erro em auth/${context}`, { err })
  res.status(500).json({ error: 'Erro interno' })
}

// POST /auth/login — público
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {}
  if (!email || !password) {
    res.status(400).json({ error: 'Os campos "email" e "password" são obrigatórios' })
    return
  }
  try {
    const result = await login(email, password)
    if (result.status === 'ok') {
      res.json({ ok: true, token: result.token })
    } else {
      // N institutions: UI mostra "Escolha a empresa" e chama /auth/select-institution
      res.json({ ok: true, select: true, selectionToken: result.token, institutions: result.institutions })
    }
  } catch (err) {
    fail(res, err, 'login')
  }
})

// POST /auth/select-institution — header: Bearer <selectionToken>
router.post('/select-institution', async (req: Request, res: Response) => {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token de seleção ausente' })
    return
  }
  const { institutionId } = req.body ?? {}
  if (!institutionId) {
    res.status(400).json({ error: 'O campo "institutionId" é obrigatório' })
    return
  }
  try {
    const token = await selectInstitution(header.split(' ')[1], Number(institutionId))
    res.json({ ok: true, token })
  } catch (err) {
    fail(res, err, 'select-institution')
  }
})

// POST /auth/recovery-password — público; resposta sempre genérica
router.post('/recovery-password', async (req: Request, res: Response) => {
  const { email } = req.body ?? {}
  if (!email) {
    res.status(400).json({ error: 'O campo "email" é obrigatório' })
    return
  }
  try {
    await recoveryPassword(String(email))
    res.json({ ok: true, message: 'Se o email existir, um código de recuperação foi enviado' })
  } catch (err) {
    fail(res, err, 'recovery-password')
  }
})

// POST /auth/change-password — público (email + código enviado por email)
router.post('/change-password', async (req: Request, res: Response) => {
  const { email, code, newPassword } = req.body ?? {}
  if (!email || !code || !newPassword) {
    res.status(400).json({ error: 'Os campos "email", "code" e "newPassword" são obrigatórios' })
    return
  }
  try {
    await changePassword(String(email), String(code), String(newPassword))
    res.json({ ok: true })
  } catch (err) {
    fail(res, err, 'change-password')
  }
})

// POST /auth/switch-institution — requer JWT final válido
router.post('/switch-institution', authMiddleware, async (req: Request, res: Response) => {
  const { institutionId } = req.body ?? {}
  if (!institutionId) {
    res.status(400).json({ error: 'O campo "institutionId" é obrigatório' })
    return
  }
  try {
    const token = await switchInstitution(req.institution!.userId, Number(institutionId))
    res.json({ ok: true, token })
  } catch (err) {
    fail(res, err, 'switch-institution')
  }
})

export default router
