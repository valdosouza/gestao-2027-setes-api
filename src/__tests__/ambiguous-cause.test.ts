/**
 * D-F98 (= Q-F104 (b), Valdo 2026-10-11) — ESPELHO do teste do núcleo (gate R19, S1): a causa do ambíguo é de uma lista FECHADA — o alarme nunca carrega texto da mensagem nem da
 * resposta (o Id do DPS de terceiro, com o CPF/CNPJ dele, inclusive alfanumérico).
 */
import { AMBIGUOUS_CAUSES, tagAmbiguous, ambiguousCauseOf } from '@shared/tax-authority/ambiguous-cause'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'

const ambiguous = (msg = 'Fisco devolveu a NFS-e de OUTRO DPS (DPS41069021ABCDE…) — nada gravado') =>
  new HttpError(502, msg, undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)

describe('D-F98 — causa FECHADA do ambíguo', () => {
  it('a causa marcada volta como foi marcada', () => {
    for (const c of AMBIGUOUS_CAUSES) expect(ambiguousCauseOf(tagAmbiguous(ambiguous(), c))).toBe(c)
  })
  it('sem marca → `nao-classificada` (o alarme continua, sem texto)', () => {
    expect(ambiguousCauseOf(ambiguous())).toBe('nao-classificada')
    expect(ambiguousCauseOf(undefined)).toBe('nao-classificada')
    expect(ambiguousCauseOf('nfse-de-outro-dps')).toBe('nao-classificada')   // string solta não é erro marcado
  })
  it('marca FORA da lista (texto da resposta posto à força) → `nao-classificada` — a lista fechada é conferida na LEITURA', () => {
    expect(ambiguousCauseOf(tagAmbiguous(ambiguous(), 'DPS41069021ABCDE' as any))).toBe('nao-classificada')
  })
  it('a lista não tem dígito nem texto variável (o rótulo é o que vai ao alarme)', () => {
    for (const c of AMBIGUOUS_CAUSES) expect(c).toMatch(/^[a-z]+(-[a-z0-9]+)*$/)
    for (const c of AMBIGUOUS_CAUSES) expect(c).not.toMatch(/\d/)
  })
  it('a marca é um SÍMBOLO: nunca serializa no corpo HTTP nem num log por JSON', () => {
    const e = tagAmbiguous(ambiguous(), 'nfse-de-outro-dps')
    expect(JSON.stringify(e)).not.toContain('nfse-de-outro-dps')
    expect(Object.keys(e)).not.toContain('ambiguousCause')
  })
  it('devolve o MESMO erro (serve a `throw tagAmbiguous(new …, causa)`) — tipo, código e status intactos', () => {
    const e = ambiguous()
    const t = tagAmbiguous(e, 'situacao-ilegivel')
    expect(t).toBe(e)
    expect(t).toBeInstanceOf(HttpError)
    expect(t).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
  })
})
