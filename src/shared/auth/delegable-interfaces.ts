/**
 * Telas do grupo Super DELEGÁVEIS a usuário da Setes (D-PV11, Valdo 2026-10-18 — `prompt_privilegios_interfaces.md`):
 *   (a) só o que está nesta lista (hoje: o vínculo estabelecimento × interfaces dos clientes — "Interfaces dos clientes");
 *   (b) a liberação é POR USUÁRIO e SÓ o Super concede — até o admin da Setes precisa do privilégio marcado (exceção à regra
 *       "admin passa o privilégio"); o cadastro de privilégios só oferece estas telas ao Super;
 *   (c) só usuário da institution da Setes — a tela não existe para os clientes;
 *   (d) as demais telas do Super seguem só do Super.
 * A licença (contrato) NÃO entra: tela do Super não é vendida — a liberação do Super é a única chave.
 *
 * Módulo-FOLHA (sem imports): a lista é lida pela guarda delegada (`super-delegation`), pela conferência de "adquirida"
 * (`require-privilege.interfaceAcquiredFor` — D-PV39) e pelo cadastro de usuários, sem ciclo de import entre eles.
 */
export const DELEGABLE_SUPER_INTERFACES: readonly string[] = ['institution-interfaces']

export function isDelegableSuperInterface(interfaceKey: string | null | undefined): boolean {
  return interfaceKey != null && DELEGABLE_SUPER_INTERFACES.includes(interfaceKey)
}
