import nodemailer from 'nodemailer'
import logger from '@shared/logger/logger'

// =====================================================================
// Mailer SMTP (recuperação de senha do setes-app).
// Configuração via .env: SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM.
// Sem SMTP_HOST configurado → modo dev: o conteúdo sai no LOG.
// =====================================================================

export function isMailerConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST)
}

function transporter() {
  const port = Number(process.env.SMTP_PORT ?? 587)

  // Regra: 465 = SSL implícito (secure true); 587/25 = STARTTLS (secure false).
  // Se SMTP_SECURE contradisser a porta, a porta manda — evita o erro
  // "wrong version number" (SSL contra porta STARTTLS e vice-versa).
  const secure = port === 465

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure && port === 587, // 587: exige upgrade STARTTLS
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  })
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
