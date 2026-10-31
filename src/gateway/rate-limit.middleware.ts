import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit'
import { Request } from 'express'
import { loginEmailBucket, bodyText } from '@shared/auth/login-email'

export const rateLimitMiddleware = rateLimit({
  windowMs:        60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req: Request) =>
    req.institution ? String(req.institution.institutionId) : req.ip ?? 'anonymous',
  message:         { error: 'Limite de requisições excedido. Tente novamente em 1 minuto.' },
})

/**
 * Limite POR E-MAIL das rotas públicas de senha (Q-PV38, 2026-10-18), além do limite por IP acima. É camada de CARGA, não a
 * garantia: vive em memória (reinício zera; cada instância conta a sua) — a garantia durável é o teto POR CONTA do pedido de
 * troca de senha (tentativas por código + emissões por janela, `auth.service.ts`). A chave é o HASH de tamanho fixo do e-mail
 * CANÔNICO (`loginEmailBucket` — o corpo aceita 2 MB; chave crua encheria a memória), e a resposta 429 é a MESMA exista o e-mail ou
 * não (nunca diz se a conta existe). SEM cabeçalhos `RateLimit-*`: o "restante" de um e-mail diria a qualquer um se outra pessoa
 * usou aquele e-mail nos últimos minutos. Sem e-mail no corpo o limite não conta (a rota responde 400).
 */
export function perEmailRateLimit(windowMinutes: number, max: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs:        windowMinutes * 60 * 1000,
    max,
    standardHeaders: false,
    legacyHeaders:   false,
    skip:            (req: Request) => !emailOf(req),
    keyGenerator:    (req: Request) => `email:${loginEmailBucket(emailOf(req))}`,
    message:         { error: `Muitas tentativas para este e-mail. Tente novamente em ${windowMinutes} minutos.` },
  })
}

/** A MESMA coerção das rotas (`bodyText`): um e-mail em array não escapa do limite; o que não vira texto não conta (a rota dá 400). */
function emailOf(req: Request): string {
  return bodyText((req.body ?? {}).email)
}
