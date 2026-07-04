import rateLimit from 'express-rate-limit'
import { Request } from 'express'

export const rateLimitMiddleware = rateLimit({
  windowMs:        60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req: Request) => req.tenant?.tenantId ?? req.ip ?? 'anonymous',
  message:         { error: 'Limite de requisições excedido. Tente novamente em 1 minuto.' },
})
