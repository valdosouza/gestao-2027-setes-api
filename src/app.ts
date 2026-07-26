import express from 'express'
import swaggerUi from 'swagger-ui-express'
import dotenv from 'dotenv'
dotenv.config()

import { authMiddleware }        from '@gateway/auth.middleware'
import { featureFlagMiddleware } from '@gateway/feature-flag.middleware'
import { rateLimitMiddleware }   from '@gateway/rate-limit.middleware'
import apiRouter                 from '@gateway/router'
import authRoutes                from '@modules/auth/auth.routes'
import logger                    from '@shared/logger/logger'
import { swaggerSpec }           from '@shared/swagger/swagger-config'

const app = express()

// CORS — o setes-app web roda em origem própria (ex.: localhost:8080).
// Origem configurável via CORS_ORIGIN; em produção, restrinja ao domínio do app.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

// Limite elevado para PUT /api/core/theme com logoBase64 (setes-app Fase 1, decisão 16)
app.use(express.json({ limit: '2mb' }))

// Swagger documentation
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))
app.get('/docs.json', (_, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.send(swaggerSpec)
})

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health Check
 *     description: Verifica se a API está rodando (sem autenticação)
 *     security: []
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: API está saudável
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }))

// Login unificado multi-institution (público, rate limit por IP)
app.use('/auth', rateLimitMiddleware, authRoutes)

// Auth JWT em todas as rotas /api
app.use('/api', authMiddleware)

// Feature flag em rotas /api
app.use('/api', featureFlagMiddleware)

app.use('/api', rateLimitMiddleware)
app.use('/api', apiRouter)

// Handler global de erros
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Erro nao tratado', { message: err.message })
  res.status(500).json({ error: 'Erro interno do servidor' })
})

export default app
