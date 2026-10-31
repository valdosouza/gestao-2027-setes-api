import { randomInt } from 'crypto'
import { PoolConnection } from 'mysql2/promise'
import { md5Password } from '@shared/auth/password'
import { SETES_INSTITUTION_ID } from '@shared/auth/roles'
import { lockUserForPasswordReset, updatePassword } from './auth.repository'

// =====================================================================================================================
// D-PV46 (Valdo, 2026-10-20 — fecha a Q-PV54 = (a)): a senha perdida do SUPER é PROCEDIMENTO DO OPERADOR, exceção explícita e
// documentada — nenhuma porta HTTP. Núcleo do `scripts/reset-super-password.ts` (roda no servidor, com o `.env` do destino).
// Parecer do guardião (2026-10-21, §13.10 do prompt de privilégios): o FATO vai na linha do domínio pela MESMA peça do fluxo normal
// (`updatePassword` — senha + `activation_key = NULL` + `updated_at`; por construção MATA qualquer código de recuperação aberto, cujo
// HMAC carrega o hash da senha), sob a MESMA trava da linha do usuário (`lockUserForPasswordReset`, regra 12 do PADROES §9); o AUTOR
// (operador do SO) vai ao LOG do script + roteiro — `tb_user` não tem `updated_by`, e o `updated_by` da casa significa id de tb_user.
// "Super" = vínculo `tb_institution_has_user.kind = 'super'` com a institution da Setes (id 1), vivo — a MESMA regra do login
// (`isSuper`: 'super' em outra institution é ignorado). `tb_user` não tem coluna `kind` (a D-PV46 cita colunas que não existem —
// leitura ratificada como A-RS5). Recusa QUALQUER outra conta, inclusive admin, e Super inativo (reativar é ato pela tela).
// =====================================================================================================================

export interface SuperAccount {
  id:         number
  active:     string
  /** e-mail de login gravado (grupo 2) — só para o operador CONFERIR quem é; o script o imprime MASCARADO */
  loginEmail: string | null
}

/**
 * Os Supers vivos (vínculo 'super' na institution da Setes; vínculo e usuário não excluídos). `active` = o MESMO predicado do login
 * (A-RS10 — gates: `tb_user.active = 'S'` E `tb_institution_has_user.active = 'S'`; o `getInstitutionsForUser` exige o vínculo ativo —
 * um vínculo adormecido (D-UC2) não loga, logo não é "Super ativo"). Leitura consistente, fora de transação.
 */
export async function listSuperAccounts(conn: Pick<PoolConnection, 'query'>): Promise<SuperAccount[]> {
  const [rows] = await conn.query<any[]>(
    `SELECT u.id, IF(u.active = 'S' AND ihu.active = 'S', 'S', 'N') AS active,
            (SELECT m.email FROM setes_central.tb_entity_has_mailing ehm
               INNER JOIN setes_central.tb_mailing m ON (m.id = ehm.tb_mailing_id)
              WHERE ehm.tb_entity_id = u.id AND ehm.tb_mailing_group_id = 2 AND ehm.deleted = 'N' AND m.deleted = 'N'
              ORDER BY m.id LIMIT 1) AS loginEmail
       FROM setes_central.tb_user u
      INNER JOIN setes_central.tb_institution_has_user ihu ON (ihu.tb_user_id = u.id)
      WHERE ihu.tb_institution_id = ? AND ihu.kind = 'super' AND ihu.deleted = 'N' AND u.deleted = 'N'
      ORDER BY u.id`,
    [SETES_INSTITUTION_ID]
  )
  return rows.map(r => ({ id: Number(r.id), active: String(r.active), loginEmail: r.loginEmail == null ? null : String(r.loginEmail) }))
}

/** Alfabeto sem os caracteres que se confundem na leitura (0/O, 1/l/I) — a senha é DITADA/anotada uma vez. */
export const INITIAL_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
export const INITIAL_PASSWORD_LENGTH = 16

/** Senha inicial aleatória (CSPRNG), 16 caracteres do alfabeto acima (~91 bits). Cabe no DTO do usuário (5–100). */
export function generateInitialPassword(length = INITIAL_PASSWORD_LENGTH): string {
  let out = ''
  for (let i = 0; i < length; i++) out += INITIAL_PASSWORD_ALPHABET[randomInt(INITIAL_PASSWORD_ALPHABET.length)]
  return out
}

/** A senha em claro vira o hash da casa AQUI (uma só vez) e segue para a transação; a peça nunca guarda a senha. */
export function hashInitialPassword(password: string): string {
  return md5Password(password)
}

export type SuperResetVerdict =
  | { status: 'reset'; userId: number }
  | { status: 'not-super'; userId: number }   // conta inexistente/excluída OU sem vínculo 'super' na Setes — a MESMA recusa, sem escrita
  | { status: 'inactive'; userId: number }    // Super com active = 'N': reativar é ato pela tela de Usuários (outro Super), não deste script

/**
 * O ATO: confere e grava na MESMA transação. Ordem: trava da linha do usuário em tb_user (serializador — regras 12/13) → vínculo
 * 'super' na institution da Setes (leitura consistente depois da trava) → `updatePassword` (a peça do fluxo normal). Qualquer outra
 * conta = recusa sem escrita. [passwordHash] já vem com o hash da casa (nunca a senha em claro chega ao repositório — decisão 2).
 */
export async function resetSuperPasswordTx(conn: PoolConnection, userId: number, passwordHash: string): Promise<SuperResetVerdict> {
  if (!/^[0-9A-F]{32}$/.test(passwordHash)) throw new Error('hash da senha fora da forma da casa (md5Password)')
  const locked = await lockUserForPasswordReset(conn, userId)
  if (!locked) return { status: 'not-super', userId }
  const [link] = await conn.query<any[]>(
    `SELECT active FROM setes_central.tb_institution_has_user
      WHERE tb_user_id = ? AND tb_institution_id = ? AND kind = 'super' AND deleted = 'N' LIMIT 1`,
    [userId, SETES_INSTITUTION_ID])
  if (!link.length) return { status: 'not-super', userId }
  // A-RS10: "ativo" = usuário E vínculo ativos (o predicado do login) — vínculo adormecido não loga, redefinir a senha não o ajudaria
  if (locked.active !== 'S' || String(link[0].active) !== 'S') return { status: 'inactive', userId }
  await updatePassword(conn, userId, passwordHash)
  return { status: 'reset', userId }
}

/** Máscara do e-mail para o log/tela do operador: `v***@setes.com.br`. */
export function maskEmail(email: string | null): string {
  if (!email) return '(sem e-mail de login)'
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}
