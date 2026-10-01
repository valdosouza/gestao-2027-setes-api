/**
 * Escapa os metacaracteres de LIKE (decisão do Valdo 2026-08-04, Q3 do
 * gate do módulo banks): sem isso, '_' vira coringa de 1 caractere e '%'
 * casa tudo no filtro digitado pelo usuário. Todo repository que monta
 * `%${filter}%` usa esta peça — o valor segue viajando em placeholder.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, m => `\\${m}`)
}
