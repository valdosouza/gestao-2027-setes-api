import { Router, Request, Response } from 'express'
import { login, selectInstitution, switchInstitution, recoveryPassword, changePassword } from './auth.service'
import { authMiddleware } from '@gateway/auth.middleware'
import { perEmailRateLimit } from '@gateway/rate-limit.middleware'
import { bodyText } from '@shared/auth/login-email'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import { maskEmailsInText } from '@shared/mailer/mailer'

const router = Router()

// Q-PV38: limite POR E-MAIL (memória — camada de carga) nas duas rotas públicas de senha, além do limite por IP do app.ts.
// A garantia durável é o teto POR CONTA do auth.service (tentativas por código + emissões por janela). Valores: Q-RS1.
export const RECOVERY_PER_EMAIL = { windowMinutes: 15, max: 5 }
export const CHANGE_PER_EMAIL   = { windowMinutes: 15, max: 10 }
const recoveryPerEmail = perEmailRateLimit(RECOVERY_PER_EMAIL.windowMinutes, RECOVERY_PER_EMAIL.max)
const changePerEmail   = perEmailRateLimit(CHANGE_PER_EMAIL.windowMinutes, CHANGE_PER_EMAIL.max)

function fail(res: Response, err: unknown, context: string) {
  if (err instanceof HttpError) {
    // o MESMO envelope do Framework de Mensagens (`handleError`): sem o `code`, o 401 SESSION_REVOKED da seleção (D-EA7) chegava ao app
    // como um 401 qualquer (gate adversarial da costura A1)
    res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.fields ? { fields: err.fields } : {}),
    })
    return
  }
  // D-EA21 (gate adversarial do delta, ADV-EA21-02): nunca o `err` CRU — o erro do mysql2 carrega `sql` com os parâmetros FORMATADOS
  // (o e-mail digitado nas três rotas públicas); só código, errno e a mensagem com todo endereço mascarado (molde do alarmNeutral)
  logger.error(`Erro em auth/${context}`, authErrorForLog(err))
  res.status(500).json({ error: 'Erro interno' })
}

function authErrorForLog(err: unknown): { code?: unknown; errno?: unknown; message: string } {
  try {
    const e = err as { code?: unknown; errno?: unknown; message?: unknown } | null
    return { code: e?.code, errno: e?.errno, message: maskEmailsInText(String(e?.message ?? err)) }
  } catch {
    return { message: '(erro sem texto legível)' }
  }
}

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Autenticação unificada (retorna token ou lista de institutions)
 *     description: |
 *       Login com email/password. Retorna JWT se o usuário tem uma institution; se múltiplas, retorna selectionToken para escolher.
 *       **Limite por CONTA (D-EA1)**: 10 senhas erradas em 15 minutos (janela deslizante) bloqueiam a conta até a falha mais velha da
 *       janela envelhecer — durante o bloqueio até a senha CERTA é recusada; não há desbloqueio manual. **Uma resposta só (D-EA6)**:
 *       senha errada, e-mail inexistente, conta sem senha, usuário inativo, usuário sem estabelecimento ativo, conta bloqueada e
 *       contenção recebem a MESMA 401 `{ "error": "Email ou senha inválidos" }`, no MESMO tempo mínimo (o 200 não espera o piso).
 *       Ao bloquear, o dono recebe um e-mail neutro (no máximo 1 por hora — D-EA3). Muitas falhas no total disparam um alarme à
 *       operação da Setes, nunca um bloqueio global (D-EA4). Limite por IP do gateway (300/min) — 429.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
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
 *                     context:
 *                       type: object
 *                       description: Estado de sessão derivado (decisão 17)
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
 *         description: Email ou password ausente, ou não é texto (array, objeto, número)
 *       401:
 *         description: Credenciais inválidas — a MESMA resposta para toda recusa (D-EA6), nunca diz o motivo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Email ou senha inválidos
 *       429:
 *         description: Limite de requisições por IP excedido
 *       500:
 *         description: Erro interno
 */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {}
  // A-EA8 / L8: só TEXTO entra — array, objeto ou número em `email`/`password` = 400 (antes, o array virava SQL inválido e o objeto
  // derrubava o hash: 500). O 400 não depende da conta (é a mesma recusa do campo ausente).
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    res.status(400).json({ error: 'Os campos "email" e "password" são obrigatórios' })
    return
  }
  try {
    const result = await login(email, password, { ip: req.ip })
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
 *     description: |
 *       Emite um código de 6 dígitos (válido por 15 minutos; substitui o código anterior) e o envia ao e-mail de login
 *       GRAVADO da conta — nunca ao texto da requisição. A resposta é SEMPRE a mesma 200 genérica: conta inexistente ou
 *       inativa e conta no teto de emissões (3 por hora e 10 por 24 h por conta — Q-PV38) não recebem código e respondem
 *       igual. O envio do e-mail não segura a resposta. Limite por e-mail (5 a cada 15 min) além do limite por IP — 429.
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
 *       429:
 *         description: Limite de pedidos por e-mail ou por IP excedido (a mesma resposta exista o e-mail ou não)
 *       500:
 *         description: Erro interno
 */
router.post('/recovery-password', recoveryPerEmail, async (req: Request, res: Response) => {
  const email = bodyText((req.body ?? {}).email)
  if (!email) {
    res.status(400).json({ error: 'O campo "email" é obrigatório' })
    return
  }
  try {
    await recoveryPassword(email)
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
 *     description: |
 *       Valida email + código + nova senha; altera a senha se o código é válido. O código vale 15 minutos e aguenta 5
 *       tentativas ERRADAS (Q-PV38): esgotado o orçamento, qualquer tentativa — mesmo com o código certo — recebe a mesma
 *       401 até um código novo ser pedido. Toda recusa (código errado, esgotado, vencido, substituído, já usado, e-mail
 *       inexistente, conta inativa) é a MESMA 401 — nunca diz se o e-mail existe. Trocar a senha ou o e-mail de login por
 *       outro caminho invalida o código aberto. Limite por e-mail (10 a cada 15 min) além do limite por IP — 429.
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
 *                 maxLength: 100
 *                 description: Política de senha (D-EA5) — mínimo 8, não pode ser só espaços, estar na lista de senhas comuns nem conter o trecho antes do @ do e-mail (4+ letras)
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
 *         description: Campos obrigatórios ausentes ou a nova senha fora da política (D-EA5) — `fields[0].field = newPassword`; julgado antes do código, só pelo texto da requisição
 *       422:
 *         description: Código CERTO, mas a nova senha é igual à atual (`PASSWORD_SAME_AS_CURRENT`) — o código segue valendo
 *       401:
 *         description: Código inválido ou expirado (a mesma resposta para toda recusa)
 *       429:
 *         description: Limite de tentativas por e-mail ou por IP excedido (a mesma resposta exista o e-mail ou não)
 *       500:
 *         description: Erro interno
 */
router.post('/change-password', changePerEmail, async (req: Request, res: Response) => {
  const body = req.body ?? {}
  const email = bodyText(body.email), code = bodyText(body.code), newPassword = bodyText(body.newPassword)
  if (!email || !code || !newPassword) {
    res.status(400).json({ error: 'Os campos "email", "code" e "newPassword" são obrigatórios' })
    return
  }
  try {
    await changePassword(email, code, newPassword)
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
