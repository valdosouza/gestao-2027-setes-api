/**
 * Privilégios canônicos do catálogo (tb_privilege — seed da casa, ids
 * estáveis desde o gestão desktop). Definições do Valdo (2026-07-12):
 * VISUALIZAR decide o que entra no MENU do usuário regular (opção 1 do
 * workflow); os demais ligam/desligam ações nas telas (decisão 21 Fase 1).
 */
export const PRIVILEGE_INSERIR    = 1
export const PRIVILEGE_ALTERAR    = 2
export const PRIVILEGE_EXCLUIR    = 3
export const PRIVILEGE_IMPRIMIR   = 4
export const PRIVILEGE_FATURAR    = 5
export const PRIVILEGE_VISUALIZAR = 6
/** Cancelar nota (D12 do cancelamento, 2026-09-08 — seed sql/51; aplicado na
 *  rota pelo guard @shared/auth/require-privilege, junto com FATURAR — Q-P5). */
export const PRIVILEGE_CANCELAR   = 7
