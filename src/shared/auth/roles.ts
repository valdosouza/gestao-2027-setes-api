import { InstitutionPayload } from '@shared/types/express'

// Institution da Setes — hard coded (Fase 2, decisão 14).
// D-PV37 (Valdo 2026-10-20 — prompt_privilegios_interfaces.md): o literal fica até a onda 1 do grupo de estabelecimentos;
// TODO lugar que precisa de "a própria Setes" lê a constante (ou o predicado `isOwnVendorInstitution`) — a troca pelo
// predicado do grupo/schema (linha do grupo, D-GE1) é um ato só. A peça `@shared/institution-interfaces` a re-exporta.
export const SETES_INSTITUTION_ID = 1

// Schema da própria Setes (PADROES_BANCO §1) — setes_central e setes_setes
// "nascem casados": são a estrutura para criar os clientes de verdade.
export const SETES_SCHEMA = 'setes_setes'

/**
 * "É a própria Setes (a fornecedora do produto)?" — D-PV37/D-PV38: um predicado só para as três portas do vínculo de interfaces
 * (lista, leitura, escrita), a delegação (D-PV11 (c)), o cadastro de privilégios e o menu. Hoje compara com o id 1; na onda 1 do
 * grupo passa a olhar o grupo/schema sem que nenhum consumidor mude.
 */
export function isOwnVendorInstitution(institutionId: number | null | undefined): boolean {
  return institutionId === SETES_INSTITUTION_ID
}

// 'super' só é reconhecido no vínculo com a institution da Setes.
// Em qualquer outra institution, role 'super' é ignorado.
export function isSuper(payload?: InstitutionPayload): boolean {
  return isOwnVendorInstitution(payload?.institutionId) && payload?.role === 'super'
}

// Admin da PRÓPRIA institution (workflow de usuários 2026-07-12): pode
// gerenciar usuários do institution logado pelo módulo Sistema. Super
// também passa (gerencia qualquer institution).
export function isAdmin(payload?: InstitutionPayload): boolean {
  return isSuper(payload) || payload?.role === 'admin'
}
