import { singleMailAddress, maskEmail } from '@shared/mailer/mailer'

/**
 * D-EA29 (Valdo 2026-11-05, "(a) Alarme no pré-voo"): CENSO dos e-mails de login que a peça de envio RECUSARIA (D-EA26/D-EA27 —
 * `singleMailAddress`). Para uma conta assim a recuperação de senha emite o código, consome o teto e não entrega nada — o único sinal era
 * um `logger.error` por pedido. O pré-voo do deploy (`scripts/pre-deploy-tz-check.ts`) mostra a contagem como ALARME: nunca recusa subir.
 *
 * SOMENTE LEITURA. A mesma junção do login (`findUserByEmail`: grupo 2, vínculo e e-mail vivos, usuário não excluído) e o MESMO predicado
 * da peça — nenhuma regra própria de endereço. O e-mail nunca sai inteiro (D-EA21 — `maskEmail`); quem corrige acha a conta pelo id.
 */
export interface UnsendableLoginEmail { userId: number; active: boolean; masked: string }
export interface LoginEmailCensus { checked: number; unsendable: UnsendableLoginEmail[] }

export async function censusUnsendableLoginEmails(
  q: { query: (sql: string, params?: any[]) => Promise<any> },
): Promise<LoginEmailCensus> {
  const [rows] = await q.query(
    `SELECT u.id AS userId, u.active, m.email
       FROM setes_central.tb_user u
      INNER JOIN setes_central.tb_entity_has_mailing ehm ON (ehm.tb_entity_id = u.id)
      INNER JOIN setes_central.tb_mailing m ON (m.id = ehm.tb_mailing_id)
      WHERE ehm.tb_mailing_group_id = 2 AND ehm.deleted = 'N' AND m.deleted = 'N' AND u.deleted = 'N'
      ORDER BY u.id, m.id`)
  const list = (rows as any[]) ?? []
  const unsendable = list
    .filter(r => singleMailAddress(r.email == null ? '' : String(r.email)) === null)
    .map(r => ({ userId: Number(r.userId), active: String(r.active) === 'S', masked: maskEmail(r.email == null ? '' : String(r.email)) }))
  return { checked: list.length, unsendable }
}
