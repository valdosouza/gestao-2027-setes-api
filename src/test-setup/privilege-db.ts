/**
 * D-PV2 (2026-10-18 — `prompt_privilegios_interfaces.md`): toda rota de tela do cliente passa pela guarda por roteador
 * (catálogo → contrato → vínculo do usuário). Testes de rota que NÃO são da guarda usam este roteador do dublê do banco:
 * as três consultas da guarda respondem "tem" e o resto segue para o roteador do próprio teste. Teste DA guarda monta as
 * respostas dela à mão (`module-privilege-gate.test.ts`, `privilegios-*.test.ts`).
 */
export function grantingPrivileges<T>(next: (sql: string, params: any[]) => Promise<T>) {
  return async (sql: string, params: any[] = []): Promise<T | unknown> => {
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) return [[{ id: 999 }]]
    if (/tb_institution_has_interface/.test(sql)) return [[{ 1: 1 }]]
    if (/tb_user_has_privilege/.test(sql)) return [[{ 1: 1 }]]
    return next(sql, params)
  }
}
