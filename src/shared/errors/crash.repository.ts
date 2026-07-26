import pool from '@shared/db/connection'
import logger from '@shared/logger/logger'

/**
 * Rastro do ERRO TÉCNICO (decisão R2 do Framework de Mensagens —
 * tb_crashlytics REFORMADA em setes_central): o `ref` curto é exibido ao
 * usuário no dialog ("informe o código X ao suporte") e amarra a linha do
 * log. Gravação FIRE-AND-SAFE: registrar o crash NUNCA pode falhar a
 * resposta (try/catch engole e loga). AUTO_INCREMENT é a exceção
 * documentada do padrão MAX+1 (log não pode falhar por corrida —
 * PADROES_BANCO §4).
 */

/** Código curto de rastro (ex.: 'K7QM3D2A') — legível por telefone. */
export function newCrashRef(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let ref = ''
  for (let i = 0; i < 8; i++) {
    ref += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return ref
}

export async function recordCrash(entry: {
  ref:           string
  code:          string
  statusCode:    number
  origen:        string
  institutionId: number
  userId:        number
  message:       string
  stack?:        string
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO setes_central.tb_crashlytics
         (tb_institution_id, tb_user_id, origen, ref, code, status_code,
          message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [entry.institutionId, entry.userId, entry.origen, entry.ref,
       entry.code, entry.statusCode,
       JSON.stringify({ message: entry.message, stack: entry.stack ?? null })]
    )
  } catch (err) {
    // nunca derruba a resposta — o log de console ainda tem o contexto
    logger.error('Falha ao gravar tb_crashlytics', { err, ref: entry.ref })
  }
}
