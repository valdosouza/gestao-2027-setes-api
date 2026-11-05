import { createHash, timingSafeEqual } from 'crypto'

/**
 * Hash de senha da casa (decisão 2 da Fase 2): MD5 UPPERCASE, sem salt
 * (risco de rainbow table aceito), aplicado SEMPRE no backend — nunca na
 * query. Usado pelo login (auth) e pelo cadastro de Usuário (users).
 */
export function md5Password(value: string): string {
  return createHash('md5').update(value).digest('hex').toUpperCase()
}

/**
 * A CONFERÊNCIA da senha digitada contra o hash gravado (login — Onda 1 do endurecer, `prompt_endurecer_autenticacao.md`), em tempo
 * CONSTANTE (`timingSafeEqual` — antes o login comparava por `!==`). Hash ausente (NULL/'') = não confere. Hoje MD5 maiúsculo (decisão 2);
 * a Onda 4 (D-EA9) troca ESTA peça por scrypt + MD5 legado — quem confere senha passa por aqui.
 */
export function passwordMatches(plain: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false
  const a = Buffer.from(md5Password(plain)), b = Buffer.from(String(storedHash).toUpperCase())
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * A senha NOVA de uma credencial: a regra mora na peça da POLÍTICA (`./password-policy` — D-EA5, Onda 3 do endurecer), que absorveu a
 * D-EA13 (nunca só espaços). Reexportada aqui para os DTOs que já importavam deste caminho.
 */
export { newPasswordSchema } from './password-policy'

/**
 * D-EA7 (Valdo 2026-10-31 — `prompt_endurecer_autenticacao.md`; parecer do guardião): o FATO "a senha que vale hoje foi definida no instante
 * T", gravado AO LADO do hash (`tb_user.password_set_at`) SÓ por quem DEFINE a senha — criação da credencial, 1ª senha de conta sem
 * credencial (A-PV23), troca pelo código da recuperação, script do Super; nunca pelo salvar do cadastro nem pela migração do hash (D-EA9).
 * A sessão viva compara o `iat` do token com ele (token anterior = 401 SESSION_REVOKED). T vem do relógio de QUEM ASSINA O TOKEN (este
 * processo), truncado ao segundo, em UTC — nunca `NOW()` do banco: com o banco adiantado, o token reemitido na mesma resposta e o 1º login
 * logo após a criação cairiam (assunção do guardião, a ratificar — exceção nomeada à letra da PADROES §10 regra 1; o valor segue UTC).
 */
export function passwordSetAt(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19).replace('T', ' ')
}
