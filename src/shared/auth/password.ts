import { createHash } from 'crypto'

/**
 * Hash de senha da casa (decisão 2 da Fase 2): MD5 UPPERCASE, sem salt
 * (risco de rainbow table aceito), aplicado SEMPRE no backend — nunca na
 * query. Usado pelo login (auth) e pelo cadastro de Usuário (users).
 */
export function md5Password(value: string): string {
  return createHash('md5').update(value).digest('hex').toUpperCase()
}
