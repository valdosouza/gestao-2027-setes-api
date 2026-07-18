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

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Autenticação unificada (retorna token ou lista de institutions)
 *     description: Login com email/password. Retorna JWT se usuário tem uma institution; se múltiplas, retorna selectionToken para escolher.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 example: senha123
 *     responses:
 *       200:
 *         description: Login bem-sucedido
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   properties:
 *                     ok:
 *                       type: boolean
 *                       example: true
 *                     token:
 *                       type: string
 *                       description: JWT válido
 *                 - type: object
 *                   properties:
 *                     ok:
 *                       type: boolean
 *                       example: true
 *                     select:
 *                       type: boolean
 *                       example: true
 *                     selectionToken:
 *                       type: string
 *                       description: Token temporário para seleção de institution
 *                     institutions:
 *                       type: array
 *                       items:
 *                         type: object
 *       400:
 *         description: Email ou password ausente
 *       401:
 *         description: Credenciais inválidas
 *       500:
 *         description: Erro interno
 */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {}
  if (!email || !password) {
    res.status(400).json({ error: 'Os campos "email" e "password" são obrigatórios' })
    return
  }
  try {
    const result = await login(email, password)
    if (result.status === 'ok') {
      // context = estado de sessão derivado (decisão 17) — UX do app;
      // enforcement continua na API.
      res.json({ ok: true, token: result.token, context: result.context })
    } else {
      // N institutions: UI mostra "Escolha a empresa" e chama /auth/select-institution
      res.json({ ok: true, select: true, selectionToken: result.token, institutions: result.institutions })
    }
  } catch (err) {
    fail(res, err, 'login')
  }
})

/**
 * @swagger
 * /auth/select-institution:
 *   post:
 *     summary: Seleciona institution quando usuário tem múltiplas
 *     description: Converte selectionToken em JWT final com institutionId escolhido
 *     tags: [Auth]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               institutionId:
 *                 type: number
 *                 example: 1
 *     responses:
 *       200:
 *         description: Institution selecionada; JWT retornado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 token:
 *                   type: string
 *       400:
 *         description: institutionId ausente ou inválido
 *       401:
 *         description: selectionToken ausente ou inválido
 *       404:
 *         description: Institution não existe ou usuário não tem acesso
 *       500:
 *         description: Erro interno
 */
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
    const issued = await selectInstitution(header.split(' ')[1], Number(institutionId))
    res.json({ ok: true, token: issued.token, context: issued.context })
  } catch (err) {
    fail(res, err, 'select-institution')
  }
})

/**
 * @swagger
 * /auth/recovery-password:
 *   post:
 *     summary: Inicia recuperação de senha (resposta genérica por segurança)
 *     description: Envia email com código de recuperação se o email existe
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 example: user@example.com
 *     responses:
 *       200:
 *         description: Resposta genérica (sempre sucesso por segurança)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *       400:
 *         description: Email ausente
 *       500:
 *         description: Erro interno
 */
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

/**
 * @swagger
 * /auth/change-password:
 *   post:
 *     summary: Altera senha com código de recuperação
 *     description: Valida email + código + nova senha; altera a senha se código é válido
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               code:
 *                 type: string
 *                 description: Código de 6 dígitos enviado por email
 *               newPassword:
 *                 type: string
 *                 minLength: 8
 *     responses:
 *       200:
 *         description: Senha alterada com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Campos obrigatórios ausentes ou senha muito curta
 *       401:
 *         description: Código inválido ou expirado
 *       500:
 *         description: Erro interno
 */
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

/**
 * @swagger
 * /auth/switch-institution:
 *   post:
 *     summary: Alterna para outra institution do usuário logado
 *     description: Retorna novo JWT com a institution escolhida
 *     tags: [Auth]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               institutionId:
 *                 type: number
 *                 example: 2
 *     responses:
 *       200:
 *         description: JWT alterado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 token:
 *                   type: string
 *       400:
 *         description: institutionId ausente
 *       401:
 *         description: JWT inválido ou expirado
 *       403:
 *         description: Usuário não tem acesso a essa institution
 *       500:
 *         description: Erro interno
 */
router.post('/switch-institution', authMiddleware, async (req: Request, res: Response) => {
  const { institutionId } = req.body ?? {}
  if (!institutionId) {
    res.status(400).json({ error: 'O campo "institutionId" é obrigatório' })
    return
  }
  try {
    const issued = await switchInstitution(req.institution!.userId, Number(institutionId))
    res.json({ ok: true, token: issued.token, context: issued.context })
  } catch (err) {
    fail(res, err, 'switch-institution')
  }
})

export default router
