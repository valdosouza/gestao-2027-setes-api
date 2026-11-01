import { createHash } from 'crypto'
import { z } from 'zod'

/**
 * Hash de senha da casa (decisão 2 da Fase 2): MD5 UPPERCASE, sem salt
 * (risco de rainbow table aceito), aplicado SEMPRE no backend — nunca na
 * query. Usado pelo login (auth) e pelo cadastro de Usuário (users).
 */
export function md5Password(value: string): string {
  return createHash('md5').update(value).digest('hex').toUpperCase()
}

/**
 * A senha NOVA de uma credencial, em TODA porta que a define pelo cadastro (criar usuário, 1ª senha de conta sem credencial — A-PV23 —,
 * admin do onboarding): 5 a 100 caracteres e NUNCA só espaços — D-EA13 (Valdo 2026-11-01, literal: *"(b) Recusar já"*;
 * `prompt_endurecer_autenticacao.md`). Espaço DENTRO vale (frase-senha). A peça da política da D-EA5 (Onda 3 do endurecer, mínimo 8)
 * absorve esta regra depois.
 */
export const newPasswordSchema = z.string().min(5).max(100)
  .refine(value => value.trim().length > 0, { message: 'A senha não pode ser só espaços' })

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
