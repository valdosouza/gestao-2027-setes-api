/// <reference types="jest" />
// D-EA29 (Valdo 2026-11-05, "(a) Alarme no pré-voo"): o censo dos e-mails de login que a peça de envio recusaria (D-EA26/D-EA27) usa o
// MESMO predicado da peça, a MESMA junção do login, só lê, e nunca devolve o e-mail inteiro (D-EA21).
import { censusUnsendableLoginEmails } from '../modules/auth/login-email-census'

const fakeDb = (rows: any[]) => {
  const query = jest.fn(async (_sql: string) => [rows])
  return { query }
}

describe('D-EA29 — censo dos e-mails de login que o envio recusaria', () => {
  it('conta só o que a peça recusa, pelo MESMO predicado (espaço do fim aparado = válido; lista, início com espaço, vazio = defeito)', async () => {
    const db = fakeDb([
      { userId: 7, active: 'S', email: 'valdo@setes.com.br' },
      { userId: 8, active: 'S', email: 'ok@x.com   ' },                      // D-EA27: só o espaço do fim — válido
      { userId: 9, active: 'S', email: 'fulano@x.com; terceiro@y.com' },     // lista
      { userId: 10, active: 'N', email: ' inicio@x.com' },                   // espaço no início (D-EA27)
      { userId: 11, active: 'S', email: '' },                                // vazio
      { userId: 12, active: 'S', email: null },
    ])
    const out = await censusUnsendableLoginEmails(db)
    expect(out.checked).toBe(6)
    expect(out.unsendable.map(u => [u.userId, u.active])).toEqual([[9, true], [10, false], [11, true], [12, true]])
    expect(JSON.stringify(out)).not.toMatch(/fulano@|terceiro@y\.com|inicio@x\.com/)   // D-EA21: nada inteiro
    expect(out.unsendable[0].masked).toMatch(/f\*\*\*@x\.com/)
  })

  it('só LÊ, pela junção do login (grupo 2, vínculo, e-mail e usuário vivos)', async () => {
    const db = fakeDb([])
    await expect(censusUnsendableLoginEmails(db)).resolves.toEqual({ checked: 0, unsendable: [] })
    const sql = String(db.query.mock.calls[0][0])
    expect(sql).toMatch(/^\s*SELECT/)
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/)
    expect(sql).toMatch(/tb_mailing_group_id = 2/)
    expect(sql).toMatch(/ehm\.deleted = 'N' AND m\.deleted = 'N' AND u\.deleted = 'N'/)
  })
})
