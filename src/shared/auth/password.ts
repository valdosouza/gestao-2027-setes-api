import { createHash } from 'crypto'

/**
 * Hash de senha da casa (decisão 2 da Fase 2): MD5 UPPERCASE, sem salt
 * (risco de rainbow table aceito), aplicado SEMPRE no backend — nunca na
 * query. Usado pelo login (auth) e pelo cadastro de Usuário (users).
 */
export function md5Password(value: string): string {
  return createHash('md5').update(value).digest('hex').toUpperCase()
}

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
