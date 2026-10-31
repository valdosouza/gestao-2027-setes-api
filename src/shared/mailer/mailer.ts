import nodemailer from 'nodemailer'
import logger from '@shared/logger/logger'

// =====================================================================
// Mailer SMTP — a única porta de e-mail do setes-api (recuperação de senha e aviso ao dono da conta — Q-PV38/D-RS4).
// Configuração via .env: SMTP_HOST/PORT/USER/PASSWORD/FROM (SMTP_SECURE é DERIVADA da porta — ver transporter()).
// Sem SMTP_HOST → modo DEV: o conteúdo sai no LOG. Em PRODUÇÃO (NODE_ENV=production) o SMTP é OBRIGATÓRIO
// (D-RS5, Valdo 2026-10-20): o boot recusa subir sem ele (`assertMailerReady`) — o código de recuperação NUNCA vai ao
// log de produção. Valores reais só no .env vivo, fornecidos pelo Valdo na publicação (nunca no repositório).
// =====================================================================

/** SMTP configurado = host não vazio (aparado — gate adversarial: `SMTP_HOST` só com espaços contava como configurado e o código ia a lugar nenhum). */
export function isMailerConfigured(): boolean {
  return Boolean((process.env.SMTP_HOST ?? '').trim())
}

const normalizedNodeEnv = () => (process.env.NODE_ENV ?? '').trim().toLowerCase()

/**
 * Produção = `NODE_ENV=production` — a casa não tem outro marcador de ambiente no setes-api. Normalizado (espaços e caixa — gate
 * adversarial: `Production`/`production ` desligavam a exigência do SMTP em silêncio); `prod`/`produção` NÃO são produção, mas o boot
 * avisa (`nodeEnvWarning`). `npm start` liga `production` por padrão (`scripts/start-production.js` — Q-RS11).
 */
export function isProduction(): boolean {
  return normalizedNodeEnv() === 'production'
}

/** Aviso do boot/pré-voo quando `NODE_ENV` parece produção mas não é a grafia exata (fail-open silencioso é o que se quer evitar). */
export function nodeEnvWarning(): string | undefined {
  const raw = process.env.NODE_ENV
  if (raw === undefined || raw === '') return undefined
  const n = normalizedNodeEnv()
  if (n === 'production') return raw === 'production' ? undefined : `NODE_ENV=${JSON.stringify(raw)} lido como production (normalizado — prefira a grafia exata)`
  if (/^prod/.test(n)) return `NODE_ENV=${JSON.stringify(raw)} NÃO é reconhecido como produção — a exigência do SMTP (D-RS5) está DESLIGADA; use exatamente "production"`
  return undefined
}

/** Porta SMTP configurada (587 por padrão — STARTTLS). NaN quando o valor não é um inteiro de porta. */
function smtpPort(): number {
  const raw = (process.env.SMTP_PORT ?? '').trim()
  if (!raw) return 587
  return /^\d{1,5}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535 ? Number(raw) : NaN
}

/**
 * O que falta ou está errado na configuração SMTP (D-RS5) — lista vazia = completa. NUNCA devolve o valor de SMTP_PASSWORD.
 * "Completa" = host, porta válida, remetente (SMTP_FROM ou SMTP_USER) e credencial inteira (usuário E senha, ou nenhum dos dois —
 * relay sem autenticação é configuração legítima, meia credencial não é).
 */
export function mailerConfigProblems(): string[] {
  const problems: string[] = []
  const host = (process.env.SMTP_HOST ?? '').trim()
  const user = (process.env.SMTP_USER ?? '').trim()
  const pass = process.env.SMTP_PASSWORD ?? ''
  const from = (process.env.SMTP_FROM ?? '').trim()
  if (!host) problems.push('SMTP_HOST ausente')
  if (Number.isNaN(smtpPort())) problems.push(`SMTP_PORT inválida (${JSON.stringify(process.env.SMTP_PORT)}) — use 465 (SSL) ou 587 (STARTTLS)`)
  if (user && !pass) problems.push('SMTP_USER informado sem SMTP_PASSWORD')
  if (!user && pass) problems.push('SMTP_PASSWORD informada sem SMTP_USER')
  if (!from && !user) problems.push('remetente ausente (SMTP_FROM ou SMTP_USER)')
  return problems
}

/** Resumo da configuração para o log do boot/pré-voo — host, porta, modo TLS, remetente e SE há usuário; nunca a senha. */
export function describeMailerConfig(): string {
  if (!isMailerConfigured()) return 'SMTP ausente'
  const port = smtpPort()
  const tls = port === 465 ? 'SSL' : port === 587 ? 'STARTTLS' : 'texto/STARTTLS oportunista'
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '(sem remetente)'
  return `smtp ${process.env.SMTP_HOST}:${Number.isNaN(port) ? '?' : port} (${tls}) de ${from}, ${process.env.SMTP_USER ? 'com' : 'sem'} autenticação`
}

/**
 * Boot (D-RS5): em PRODUÇÃO o setes-api NÃO sobe sem SMTP completo — senão o código de recuperação de senha iria ao LOG (ou a lugar
 * nenhum) e o aviso ao dono da conta (D-RS4) morreria em silêncio. Fora de produção devolve o resumo (ou avisa o modo dev).
 */
export function assertMailerReady(): string {
  const problems = mailerConfigProblems()
  if (isProduction()) {
    if (problems.length) {
      throw new Error(`SMTP obrigatório em produção (D-RS5) — ${problems.join('; ')}. Preencha SMTP_HOST/SMTP_PORT/SMTP_USER/`
        + `SMTP_PASSWORD/SMTP_FROM no .env vivo (valores fornecidos pelo Valdo na publicação) ANTES de subir o setes-api.`)
    }
    return describeMailerConfig()
  }
  // fora de produção o resumo NOMEIA um NODE_ENV estranho ("prod", "produção"): o fail-open nunca é silencioso (gate adversarial)
  const warning = nodeEnvWarning()
  const prefix = warning ? `⚠️ ${warning} · ` : ''
  if (!isMailerConfigured()) return `${prefix}SMTP ausente — modo DEV: o código de recuperação de senha vai ao LOG (em produção o boot recusaria — D-RS5)`
  if (problems.length) return `${prefix}${describeMailerConfig()} ⚠️ incompleta: ${problems.join('; ')} (em produção o boot recusaria — D-RS5)`
  return `${prefix}${describeMailerConfig()}`
}

function transporter() {
  const port = smtpPort()

  // Regra: 465 = SSL implícito (secure true); 587/25 = STARTTLS (secure false).
  // Se SMTP_SECURE contradisser a porta, a porta manda — evita o erro
  // "wrong version number" (SSL contra porta STARTTLS e vice-versa).
  const secure = port === 465

  return nodemailer.createTransport({
    host: (process.env.SMTP_HOST ?? '').trim(),
    port,
    secure,
    requireTLS: !secure && port === 587, // 587: exige upgrade STARTTLS
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    // A-RS11 (gate socrático, LOW): um SMTP mudo não prende o trabalho em segundo plano por 10 min (padrão do nodemailer)
    connectionTimeout: 15_000,
    greetingTimeout:   15_000,
    socketTimeout:     30_000,
  })
}

/**
 * Pré-voo (D-RS5, `scripts/pre-deploy-tz-check.ts`): abre a conexão SMTP e autentica (EHLO/STARTTLS/AUTH) SEM enviar nada.
 * Nunca roda no boot (o SMTP fora do ar não pode derrubar a API — o e-mail já corre em segundo plano). Falha vira texto,
 * sem a senha; estourou o tempo = falha.
 */
export async function verifyMailerConnection(timeoutMs = 15_000): Promise<{ ok: boolean; detail: string }> {
  const problems = mailerConfigProblems()
  if (problems.length) return { ok: false, detail: `configuração incompleta: ${problems.join('; ')}` }
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      transporter().verify(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`sem resposta do SMTP em ${timeoutMs} ms`)), timeoutMs) }),
    ])
    return { ok: true, detail: describeMailerConfig() }
  } catch (err) {
    const e = err as { code?: unknown; responseCode?: unknown; message?: unknown } | null
    return { ok: false, detail: `${describeMailerConfig()} — ${e?.code ?? ''} ${e?.responseCode ?? ''} ${String(e?.message ?? err)}`.replace(/\s+/g, ' ').trim() }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface MailMessage {
  to:      string
  subject: string
  html:    string
  text?:   string
}

export async function sendMail(message: MailMessage): Promise<void> {
  if (!isMailerConfigured()) {
    logger.warn('SMTP não configurado — email NÃO enviado (modo dev, conteúdo no log)', {
      to: message.to, subject: message.subject,
    })
    return
  }
  await transporter().sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to:      message.to,
    subject: message.subject,
    html:    message.html,
    text:    message.text,
  })
  logger.info('Email enviado', { to: message.to, subject: message.subject })
}
