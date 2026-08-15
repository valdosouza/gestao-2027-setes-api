import { EntityFiscalInput, EntityFiscalFull } from '@shared/entity'

/**
 * Tipos do CONCRETO Institution (tb_institution na setes_central).
 * A cadeia de entidade fiscal é COMPARTILHADA: @shared/entity/entity.types
 * (skill cadastro-entidade-fiscal.md) — aqui fica só o que é do concreto.
 * Espelho no app: apps/web/lib/app/modules/institutions/domain/entity/object_institution.dart
 * (cadeia base em apps/web/lib/app/shared/entity/domain/).
 */

/** Cadeia completa + campos do concreto enviados no POST/PUT. */
export interface InstitutionInput extends EntityFiscalInput {
  active?: 'S' | 'N'
}

/** Linha da pesquisa (GET /api/institutions). */
export interface InstitutionListRow {
  id:          number
  nickTrade:   string | null
  nameCompany: string | null
  schemaName:  string
  active:      'S' | 'N' | null
}

/** Objeto COMPLETO devolvido no GET /api/institutions/:id. */
export interface InstitutionFull extends EntityFiscalFull {
  schemaName: string
  active:     'S' | 'N' | null
}

/**
 * Primeiro administrador do cliente, criado no PRÓPRIO onboarding (decisão
 * do Valdo, 2026-08-15 — A2: cliente nunca existe sem dono). Vira um usuário
 * comum da cadeia central com vínculo kind='admin' nesta institution.
 */
export interface InstitutionAdminInput {
  nameCompany: string
  nickTrade:   string
  email:       string
  password:    string
}

/**
 * Chave de sincronização da institution (tb_sync_api_key — D12 da revisão
 * do sincronizador: uma chave por estabelecimento, header X-Api-Key).
 * GET/POST /api/institutions/:id/sync-api-key.
 */
export interface SyncApiKeyRow {
  apiKey:            string
  establishmentCode: string
  active:            'S' | 'N'
}
