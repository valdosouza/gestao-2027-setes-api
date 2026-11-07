import { randomInt } from 'crypto'
import { PoolConnection } from 'mysql2/promise'
import { hashPassword, storedPasswordForm } from '@shared/auth/password'
import { passwordProblems } from '@shared/auth/password-policy'
import { SETES_INSTITUTION_ID } from '@shared/auth/roles'
import { sendMail, isMailerConfigured, isProduction, maskEmail, mailErrorForLog, singleMailAddress } from '@shared/mailer/mailer'
import { institutionZoneFor, isValidTimeZone, DEFAULT_TIME_ZONE, Queryable } from '@shared/time-zone'
import logger from '@shared/logger/logger'
import { lockUserCredential, updatePassword } from './auth.repository'

// =====================================================================================================================
// D-PV46 (Valdo, 2026-10-20 — fecha a Q-PV54 = (a)): a senha perdida do SUPER é PROCEDIMENTO DO OPERADOR, exceção explícita e
// documentada — nenhuma porta HTTP. Núcleo do `scripts/reset-super-password.ts` (roda no servidor, com o `.env` do destino).
// Parecer do guardião (2026-10-21, §13.10 do prompt de privilégios): o FATO vai na linha do domínio pela MESMA peça do fluxo normal
// (`updatePassword` — senha + `activation_key = NULL` + `updated_at`; por construção MATA qualquer código de recuperação aberto, cujo
// HMAC carrega o hash da senha), sob a MESMA trava da linha do usuário (`lockUserCredential`, regra 12 do PADROES §9); o AUTOR
// (operador do SO) vai ao LOG do script + roteiro — `tb_user` não tem `updated_by`, e o `updated_by` da casa significa id de tb_user.
// "Super" = vínculo `tb_institution_has_user.kind = 'super'` com a institution da Setes (id 1), vivo — a MESMA regra do login
// (comparado em BINÁRIO, sem caixa nem PAD SPACE — o mesmo julgamento da `vw_user_link`; re-gate socrático da costura A1, L2)
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
  // D-EA23: TODOS os candidatos a e-mail de login (grupo 2, vivos, não brancos, na ordem do id) — quem escolhe é a peça `pickLoginEmail`,
  // a MESMA regra que o ato aplica sob a trava. O separador é a quebra de linha; o e-mail GRAVADO que a contém fica FORA da lista (gate
  // adversarial do delta final, ADV-FG-01: "lixo\natacante@x" se partia num pedaço válido que a lista escolhia e o ato não) — o ato o
  // recusa inteiro pela mesma peça, então os dois lados ficam com o MESMO conjunto de candidatos. `gcMax` = o limite do GROUP_CONCAT do
  // servidor: a lista que o atinge saiu CORTADA (MySQL 8 padrão = 1024) e é recusada, nunca lida pela metade.
  const [rows] = await conn.query<any[]>(
    `SELECT u.id, IF(u.active = 'S' AND ihu.active = 'S', 'S', 'N') AS active, @@SESSION.group_concat_max_len AS gcMax,
            (SELECT GROUP_CONCAT(m.email ORDER BY m.id SEPARATOR '\\n') FROM setes_central.tb_entity_has_mailing ehm
               INNER JOIN setes_central.tb_mailing m ON (m.id = ehm.tb_mailing_id)
              WHERE ehm.tb_entity_id = u.id AND ehm.tb_mailing_group_id = 2 AND ehm.deleted = 'N' AND m.deleted = 'N'
                AND TRIM(m.email) <> '' AND INSTR(m.email, CHAR(10)) = 0) AS loginEmails
       FROM setes_central.tb_user u
      INNER JOIN setes_central.tb_institution_has_user ihu ON (ihu.tb_user_id = u.id)
      WHERE ihu.tb_institution_id = ? AND BINARY ihu.kind = 'super' AND ihu.deleted = 'N' AND u.deleted = 'N'
      ORDER BY u.id`,
    [SETES_INSTITUTION_ID]
  )
  return rows.map(r => {
    if (r.loginEmails != null && r.gcMax != null && Buffer.byteLength(String(r.loginEmails), 'utf8') >= Number(r.gcMax)) {
      throw new Error(`lista de e-mails de login do Super id=${r.id} CORTADA pelo group_concat_max_len (${r.gcMax}) do servidor — `
        + 'aumente-o e rode de novo (nada foi gravado)')
    }
    return {
      id: Number(r.id), active: String(r.active),
      loginEmail: pickLoginEmail(r.loginEmails == null ? [] : String(r.loginEmails).split('\n')),
    }
  })
}

/**
 * D-EA23 (Valdo 2026-11-01, "(a) Regra única"): "o e-mail de login do Super" para o script é UM só, escolhido por UMA regra — o 1º (na
 * ordem do id) e-mail de login vivo que, APARADO (só o espaço do fim — D-EA27), é um endereço válido pelo MESMO validador do cadastro (`z.email()`); devolvido aparado.
 * Nenhum válido = null (o script recusa — D-EA20). A lista, o ensaio e o ATO (sob a trava) usam esta peça; o aviso vai ao e-mail que o
 * ATO escolheu (devolvido no veredito). Antes eram três regras e, com dado sujo (1º em branco, espaço no fim, troca por SQL entre a lista e
 * o ato), a senha era trocada e o aviso não saía ou ia ao e-mail velho (gate adversarial do delta, ADV-EA20-01/02).
 */
export function pickLoginEmail(candidates: Array<string | null | undefined>): string | null {
  for (const raw of candidates) {
    const v = singleMailAddress(raw)                     // D-EA26: o MESMO predicado da peça de envio (aparado + `z.email()`)
    if (v) return v
  }
  return null
}

export interface SuperTargetArgs { userId?: number; email?: string }
export type SuperTargetChoice = { target: SuperAccount } | { refusal: string }

/**
 * Escolha do alvo do script (D-RS7, Valdo 2026-10-31 — revê a 2ª metade da A-RS8): o alvo NOMEADO por `--user-id`/`--email` vale entre
 * QUALQUER Super vivo, ativo ou não (o inativo é recusado depois, no ato — D-RS16); SEM nome, só o ÚNICO Super ativo é implícito — com
 * 2+ ativos o script RECUSA e pede o nome (nunca escolhe sozinho). A recusa não aponta tela nenhuma: pela D-PV48 ninguém define a senha
 * de outro depois de criada a credencial — a saída "um Super define a do outro pela tela" morreu.
 */
export function pickSuperTarget(supers: SuperAccount[], args: SuperTargetArgs): SuperTargetChoice {
  if (args.userId !== undefined) {
    const s = supers.find(x => x.id === args.userId)
    return s ? { target: s }
      : { refusal: `o usuário ${args.userId} não é Super (ou está excluído) — este script só redefine a senha do Super (D-PV46)` }
  }
  if (args.email !== undefined) {
    // gate adversarial (ADV-RS7-01): e-mail vazio/só espaços nunca casa — senão casaria o Super SEM e-mail de login (null ≈ '')
    const wanted = args.email.trim().toLowerCase()
    if (!wanted) return { refusal: '--email exige o e-mail de login' }
    const found = supers.filter(x => x.loginEmail !== null && x.loginEmail.trim().toLowerCase() === wanted)
    return found.length === 1 ? { target: found[0] }
      : { refusal: 'nenhum Super (ou mais de um) com o e-mail de login informado — este script só redefine a senha do Super (D-PV46)' }
  }
  const active = supers.filter(s => s.active === 'S')
  if (active.length === 1) return { target: active[0] }
  if (active.length > 1) {
    return { refusal: `há ${active.length} Supers ATIVOS (ids ${active.map(s => s.id).join(', ')}): nomeie o alvo com --user-id <id> `
      + 'ou --email <login> — o script nunca escolhe sozinho entre mais de um (D-RS7)' }
  }
  return { refusal: supers.length === 0
    ? 'nenhum Super vivo na institution da Setes — nada a fazer'
    : `nenhum Super ATIVO (${supers.length} inativo(s)) e o script não reativa (D-RS16): ${INACTIVE_WITHOUT_ACTIVE_EXIT}` }
}

/** D-EA20: a saída do Super SEM e-mail de login — o login é pelo e-mail; o script não cadastra e-mail (fora da exceção da D-PV46). */
export const NO_LOGIN_EMAIL_EXIT =
  'o login é pelo e-mail — cadastre o e-mail de login do Super antes e rode de novo (D-EA20)'

/**
 * A saída de um Super INATIVO (D-RS16 — o script nunca reativa): com OUTRO Super ativo, ele reativa pela tela de Usuários; sem nenhum
 * outro ativo, só SQL manual do operador (limite conhecido). Gate adversarial ADV-RS16-01: o ensaio e a recusa dizem a saída REAL,
 * nunca "nomeie o alvo" nem "outro Super" que não existe.
 */
export const INACTIVE_WITHOUT_ACTIVE_EXIT =
  'não há outro Super ativo para reativá-lo pela tela — só por SQL manual do operador (limite conhecido da D-RS16)'
export function inactiveTargetExit(supers: SuperAccount[], target: SuperAccount): string {
  return supers.some(s => s.active === 'S' && s.id !== target.id)
    ? 'reative-o pela tela de Usuários (outro Super ativo) antes; este script não reativa (D-RS16)'
    : INACTIVE_WITHOUT_ACTIVE_EXIT
}

/** Alfabeto sem os caracteres que se confundem na leitura (0/O, 1/l/I) — a senha é DITADA/anotada uma vez. */
export const INITIAL_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
export const INITIAL_PASSWORD_LENGTH = 16

/** Senha inicial aleatória (CSPRNG), 16 caracteres do alfabeto acima (~91 bits). Cumpre a política de senha (D-EA5 — §P.5 PP6;
 *  o teste `password-policy-d-ea5` confere amostras contra a peça). */
export function generateInitialPassword(length = INITIAL_PASSWORD_LENGTH): string {
  // a MESMA peça da política (gate socrático da Onda 3, LOW 4): se o alfabeto ou o tamanho mudarem, o sorteio nunca entrega senha fora dela
  for (let attempt = 0; attempt < 100; attempt++) {
    let out = ''
    for (let i = 0; i < length; i++) out += INITIAL_PASSWORD_ALPHABET[randomInt(INITIAL_PASSWORD_ALPHABET.length)]
    if (passwordProblems(out).length === 0) return out
  }
  throw new Error('generateInitialPassword: o alfabeto/tamanho não produz senha dentro da política de senha (D-EA5)')
}

/**
 * A senha em claro vira o hash da casa AQUI (uma só vez — a peça `@shared/auth/password`, scrypt no peso vigente; D-EA9) e segue para a
 * transação; a peça nunca guarda a senha. Assíncrona: calculada ANTES da transação (nunca sob a trava).
 */
export function hashInitialPassword(password: string): Promise<string> {
  return hashPassword(password)
}

export type SuperResetVerdict =
  | { status: 'reset'; userId: number; loginEmail: string }   // D-EA23: o e-mail de login escolhido SOB a trava — o aviso vai a ele
  | { status: 'not-super'; userId: number }   // conta inexistente/excluída OU sem vínculo 'super' na Setes — a MESMA recusa, sem escrita
  | { status: 'inactive'; userId: number }    // Super com active = 'N': reativar é ato pela tela de Usuários (outro Super), não deste script
  | { status: 'no-login-email'; userId: number }   // D-EA20: Super sem e-mail de login — a senha nova não serviria para entrar; sem escrita

/**
 * O ATO: confere e grava na MESMA transação. Ordem: trava da linha do usuário em tb_user (serializador — regras 12/13) → vínculo
 * 'super' na institution da Setes (leitura consistente depois da trava) → usuário E vínculo ativos (D-RS14) → e-mail de login vivo
 * (D-EA20) → `updatePassword` (a peça do fluxo normal). Qualquer recusa = sem escrita. [passwordHash] já vem com o hash da casa (nunca a senha em claro chega ao repositório — decisão 2).
 */
export async function resetSuperPasswordTx(conn: PoolConnection, userId: number, passwordHash: string): Promise<SuperResetVerdict> {
  // D-EA9: só o formato NOVO entra — o MD5 legado (32 hex) é só conferido no login, nunca gravado
  if (storedPasswordForm(passwordHash) !== 'scrypt') throw new Error('hash da senha fora da forma da casa (scrypt da @shared/auth/password)')
  const locked = await lockUserCredential(conn, userId)
  if (!locked) return { status: 'not-super', userId }
  const [link] = await conn.query<any[]>(
    `SELECT active FROM setes_central.tb_institution_has_user
      WHERE tb_user_id = ? AND tb_institution_id = ? AND BINARY kind = 'super' AND deleted = 'N' LIMIT 1`,
    [userId, SETES_INSTITUTION_ID])
  if (!link.length) return { status: 'not-super', userId }
  // A-RS10: "ativo" = usuário E vínculo ativos (o predicado do login) — vínculo adormecido não loga, redefinir a senha não o ajudaria
  if (locked.active !== 'S' || String(link[0].active) !== 'S') return { status: 'inactive', userId }
  // D-EA20 (Valdo 2026-11-01, "(a) Recusar"): o login é pelo e-mail — sem e-mail de login a senha nova não serve para entrar e o aviso da
  // D-RS13 não tem destino; a troca só derrubaria as sessões (D-EA7). D-EA23: o e-mail que vale é o da peça `pickLoginEmail` (a MESMA regra
  // da lista e do ensaio), escolhido SOB a trava e devolvido no veredito — o aviso vai a ele. Nenhum válido = recusa sem escrita.
  const [mail] = await conn.query<any[]>(
    `SELECT m.email FROM setes_central.tb_entity_has_mailing ehm
       INNER JOIN setes_central.tb_mailing m ON (m.id = ehm.tb_mailing_id)
      WHERE ehm.tb_entity_id = ? AND ehm.tb_mailing_group_id = 2 AND ehm.deleted = 'N' AND m.deleted = 'N' AND TRIM(m.email) <> ''
      ORDER BY m.id`,
    [userId])
  const loginEmail = pickLoginEmail((mail as any[]).map(r => (r?.email == null ? null : String(r.email))))
  if (!loginEmail) return { status: 'no-login-email', userId }
  await updatePassword(conn, userId, passwordHash)
  return { status: 'reset', userId, loginEmail }
}

/** Máscara do e-mail para o log/tela do operador: `v***@setes.com.br` — a regra é UMA, da peça de envio (D-EA21). */
export { maskEmail }

// ---------------------------------------------------------------------------------------------------------------------------------
// D-RS13 (Valdo, 2026-10-31 — fecha a Q-RS13 = (b)): depois de GRAVAR, o script avisa o próprio Super por e-mail — texto NEUTRO, sem
// link de ação (A-RS7: link = vetor de phishing por imitação), com o instante na zona do estabelecimento da Setes; vai ao e-mail de login
// GRAVADO (nunca a um texto digitado). Sem DDL: o fato durável "senha definida por terceiro" nasce com a credencial da auth-api (D-AU5).
// A falha do envio NÃO desfaz a troca (só log) — este aviso nunca lança. A senha NUNCA entra aqui (a função nem a recebe).
// ---------------------------------------------------------------------------------------------------------------------------------

/** Assunto do aviso — distinto do código e do aviso de tentativas (D-RS4); os testes separam os e-mails por ele. */
export const SUPER_RESET_NOTICE_SUBJECT = 'Setes — a senha da sua conta foi redefinida'

/**
 * Zona do estabelecimento da Setes (config `time_zone`, a mesma da casa) para o instante do aviso. O script não tem JWT: lê o schema da
 * institution da Setes e pede a zona pela peça do fuso. Qualquer falha cai na zona padrão — o aviso nunca depende dela para sair.
 */
/**
 * Teto da leitura da zona (gate socrático do delta final): ela roda DEPOIS do COMMIT e ANTES do aviso; com o banco travado ela segurava a
 * senha sem limite, fora do teto da D-EA24. Estourado = zona padrão (a mesma saída de qualquer falha — o aviso nunca depende dela).
 */
export const SUPER_ZONE_CAP_MS = 5_000

export async function setesInstitutionZone(q: Queryable, capMs: number = SUPER_ZONE_CAP_MS): Promise<string> {
  const reading = (async () => {
    try {
      const [rows] = await q.query('SELECT schema_name AS schemaName FROM setes_central.tb_institution WHERE id = ? LIMIT 1', [SETES_INSTITUTION_ID])
      const schema = (rows as any[])?.[0]?.schemaName
      return schema ? await institutionZoneFor(String(schema), SETES_INSTITUTION_ID, q) : DEFAULT_TIME_ZONE
    } catch (err) {
      logger.warn('D-RS13: zona do estabelecimento da Setes ilegível — o aviso usa a zona padrão', { message: (err as Error)?.message })
      return DEFAULT_TIME_ZONE
    }
  })()                                                    // nunca rejeita: a leitura que perder a corrida termina sozinha, sem rejeição solta
  let timer: NodeJS.Timeout | undefined
  const cap = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), capMs) })
  try {
    const zone = await Promise.race([reading, cap])
    if (zone !== null) return zone
    logger.warn(`D-RS13: zona do estabelecimento da Setes sem resposta em ${Math.round(capMs / 1000)} s — o aviso usa a zona padrão`)
    return DEFAULT_TIME_ZONE
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** O instante [at] como parede na [zone], em pt-BR ("01/11/2026 15:42"), com o nome da zona. Zona inválida = a padrão. */
export function wallTimeInZone(at: Date, zone: string): string {
  const z = isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE
  const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', {
    timeZone: z, hourCycle: 'h23', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at).map(x => [x.type, x.value]))
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} (fuso ${z})`
}

/** O texto único do aviso (D-RS13) — neutro, sem link, sem senha, sem dizer quem é o operador (o autor fica no LOG do script). */
export function superResetNoticeText(at: Date, zone: string): string {
  return `A senha da sua conta de Super do Setes ERP foi redefinida pelo operador do servidor em ${wallTimeInZone(at, zone)}. `
    + 'A senha inicial é entregue a você por outro canal; depois de entrar, defina a sua. '
    + 'Se você não reconhece esta troca, avise imediatamente a equipe da Setes. Não respondemos a este e-mail.'
}

export type SuperResetNoticeOutcome = 'sent' | 'logged' | 'no-email' | 'failed' | 'unconfirmed'

/**
 * D-EA24 (Valdo 2026-11-01, "(a) Teto de 60 s"): teto TOTAL da espera do aviso ao Super. Os tetos do SMTP (15/15/30 s + DNS 15 s) não
 * limitam o total — o de 30 s conta só silêncio, e um servidor que responde aos poucos prendia o aviso sem fim (gate adversarial do delta,
 * ADV-EA19-02: aos 62 s seguia pendente, com a senha gravada e sem aparecer). Estourado o teto, o desfecho é 'unconfirmed' ("não confirmado
 * — pode ainda sair") e a senha aparece; o envio SEGUE em segundo plano e o resultado tardio vai ao log (mascarado).
 */
export const SUPER_NOTICE_CAP_MS = 60_000

/**
 * Manda o aviso da D-RS13 ao e-mail de login gravado do Super [account]. NUNCA lança: falha do envio = `logger.error` + 'failed' (a troca
 * da senha já foi gravada e fica — D-RS13). Sem e-mail de login = 'no-email' (aviso no log). Fora de produção sem SMTP o conteúdo vai ao
 * log (molde D-RS4/D-RS18) = 'logged'. Chamar SÓ depois do COMMIT e FORA da retentativa de deadlock (um aviso por troca gravada).
 */
export async function sendSuperResetNotice(
  account: SuperAccount, at: Date, zone: string, capMs: number = SUPER_NOTICE_CAP_MS,
): Promise<SuperResetNoticeOutcome> {
  try {
    if (!account.loginEmail) {
      logger.warn('D-RS13: Super sem e-mail de login — aviso da redefinição NÃO enviado', { userId: account.id })
      return 'no-email'
    }
    // gate adversarial (ADV-RS13-02): o e-mail GRAVADO pode ter entrado fora da porta validada (SQL, carga) — o nodemailer lê "a@x, b@y"
    // como LISTA e mandaria o aviso de segurança também a um terceiro. Só sai para UM endereço, pelo MESMO validador do cadastro.
    // D-EA26: a regra é a da peça (`singleMailAddress`, a MESMA da `sendMail`, que também recusa) — aqui só para o log dizer a causa
    // (gate socrático do delta final: a conferência própria era mais estrita que a peça)
    if (!singleMailAddress(account.loginEmail)) {
      logger.error('D-RS13: e-mail de login GRAVADO do Super não é um endereço único válido — aviso NÃO enviado; a senha SEGUE redefinida',
        { userId: account.id, to: maskEmail(account.loginEmail) })
      return 'failed'
    }
    const text = superResetNoticeText(at, zone)
    const configured = isMailerConfigured()
    const sending = sendMail({
      to: account.loginEmail,
      subject: SUPER_RESET_NOTICE_SUBJECT,
      text,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#1B3A5F">Aviso de segurança</h2>
          <p>A senha da sua conta de Super do Setes ERP foi redefinida pelo operador do servidor em <strong>${wallTimeInZone(at, zone)}</strong>.</p>
          <p>A senha inicial é entregue a você por outro canal; depois de entrar, defina a sua.</p>
          <p><strong>Se você não reconhece esta troca</strong>, avise imediatamente a equipe da Setes.</p>
          <p style="color:#8793B2;font-size:12px">Não respondemos a este e-mail.</p>
        </div>`,
    })
    // D-EA24: corrida entre o envio e o teto TOTAL. O envio que perder a corrida segue em segundo plano — o desfecho tardio vai ao log
    // (nunca como rejeição solta: derrubaria o processo)
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<'cap'>(resolve => { timer = setTimeout(() => resolve('cap'), capMs) })
    let first: 'done' | 'cap'
    try {
      first = await Promise.race([sending.then(() => 'done' as const), cap])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (first === 'cap') {
      const to = maskEmail(account.loginEmail)
      logger.warn(`D-EA24: aviso ao Super NÃO confirmado em ${Math.round(capMs / 1000)} s — o envio segue em segundo plano; a senha SEGUE `
        + 'redefinida', { userId: account.id, to })
      sending.then(
        () => logger.info('D-EA24: aviso ao Super confirmado DEPOIS do teto', { userId: account.id, to }),
        err => {
          try { logger.error('D-EA24: aviso ao Super FALHOU depois do teto', { userId: account.id, to, ...mailErrorForLog(err) }) } catch { /* sem log */ }
        })
      return 'unconfirmed'
    }
    if (configured) return 'sent'
    // o script roda FORA do boot (sem o `assertMailerReady`): em produção sem SMTP o aviso não saiu — é falha, nunca "foi ao log"
    if (isProduction()) {
      logger.error('D-RS13: SMTP ausente em PRODUÇÃO — aviso ao Super NÃO enviado; a senha SEGUE redefinida', { userId: account.id })
      return 'failed'
    }
    logger.info('D-RS13: aviso ao Super (modo dev, SMTP ausente)', { userId: account.id, to: maskEmail(account.loginEmail), text })
    return 'logged'
  } catch (err) {
    // D-EA21: o erro do SMTP vai ao log com TODO endereço mascarado (o nodemailer põe o destinatário na mensagem). A peça NUNCA lança
    // (ADV-EA19-01): o `mailErrorForLog` não lança, e um log que falhe mesmo assim não derruba o desfecho — a senha ainda aparece.
    try {
      logger.error('D-RS13: falha no envio do aviso ao Super — a senha SEGUE redefinida', {
        userId: account.id, to: maskEmail(account.loginEmail), ...mailErrorForLog(err),
      })
    } catch { /* o desfecho 'failed' vale mesmo sem o log */ }
    return 'failed'
  }
}
