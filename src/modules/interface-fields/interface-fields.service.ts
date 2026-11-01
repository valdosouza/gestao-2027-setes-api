import { InstitutionPayload } from '@shared/types/express'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import {
  getResolvedFields, invalidateFieldConfig, findInterfaceIdByKey, ResolvedField,
} from '@shared/field-config'
import {
  InterfaceVitrineRow, listVitrine, interfaceExists, vitrineSearchCriteria,
} from '@shared/interface-vitrine'
import { assertCanConfigure, canConfigure } from '@shared/auth/configure-privilege'
import { interfaceAcquiredFor } from '@shared/auth/require-privilege'
import { ErrorCodes } from '@shared/errors/error-codes'
import { FieldConfigInput } from './interface-fields.interface'
import { getCatalogFieldRequired, upsertFieldConfig } from './interface-fields.repository'

/**
 * Regra do painel de campos configuráveis (decisões 2, 3 e 6 da Fase 2):
 * vitrine com todas as interfaces; campos resolvidos (inclusive travados);
 * gravação só em interface adquirida (D-PV24: o super escapa; D-PV39: tela delegável = adquirida pela Setes) e NUNCA
 * afrouxando o baseline técnico. D-PV25 (Valdo 2026-10-20): gravar required/caption/mask de um campo da tela X exige
 * CONFIGURAR em X (a interface ALVO), por qualquer caminho — o ALTERAR do painel perdeu o consumidor (D-PV6 superada).
 * `canConfigure` sai no GET /:id (aditivo) para a tela saber se o painel está editável.
 */

/** Lista branca da vitrine deste painel (peça @shared/interface-vitrine — D-BA20). */
export const INTERFACE_FIELD_SEARCH_CRITERIA = vitrineSearchCriteria('interface-fields')

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchVitrineSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(INTERFACE_FIELD_SEARCH_CRITERIA)
}

export async function fetchVitrine(
  institution: InstitutionPayload, query: ListQuery
): Promise<PagedRows<InterfaceVitrineRow>> {
  return listVitrine(query, institution.schemaName, institution.institutionId)
}

export type ResolvedFieldForUser = ResolvedField & { canConfigure: boolean }

export async function fetchResolvedFields(
  institution: InstitutionPayload, interfaceId: number
): Promise<ResolvedFieldForUser[]> {
  if (!(await interfaceExists(interfaceId))) {
    throw new HttpError(404, 'Interface não encontrada')
  }
  const fields = await getResolvedFields(
    institution.schemaName, institution.institutionId, interfaceId
  )
  if (fields.length === 0) return []
  const allowed = await canConfigure(institution, interfaceId)     // D-PV25
  return fields.map(f => ({ ...f, canConfigure: allowed }))
}

/**
 * Config resolvida pela CHAVE do módulo (i18n_key = nome do módulo nos dois
 * lados) — consumida pelo engine de montagem das telas (decisão 7). Módulo
 * sem catálogo devolve lista vazia: a tela monta com os padrões do código.
 */
export async function fetchResolvedFieldsByKey(
  institution: InstitutionPayload, moduleKey: string
): Promise<ResolvedField[]> {
  const interfaceId = await findInterfaceIdByKey(moduleKey)
  if (interfaceId === null) return []
  return getResolvedFields(
    institution.schemaName, institution.institutionId, interfaceId
  )
}

export async function saveFieldConfig(
  institution: InstitutionPayload, interfaceId: number,
  fieldName: string, input: FieldConfigInput
): Promise<void> {
  if (!(await interfaceExists(interfaceId))) {
    throw new HttpError(404, 'Interface não encontrada')
  }
  // D-PV24/D-PV39: o super escapa do "adquirida"; a tela delegável conta como adquirida pela Setes
  if (!(await interfaceAcquiredFor(institution, interfaceId))) {
    throw new HttpError(403, 'Interface não adquirida — configuração indisponível', [], ErrorCodes.INTERFACE_NOT_ALLOWED)
  }
  // D-PV25: o campo da tela X se ajusta com CONFIGURAR em X (admin passa, super escapa)
  await assertCanConfigure(institution, interfaceId)

  const requiredTech = await getCatalogFieldRequired(interfaceId, fieldName)
  if (requiredTech === null) {
    throw new HttpError(404, 'Campo não existe no catálogo desta interface')
  }
  // Decisão 2: o cliente só APERTA — baseline técnico é inegociável.
  if (requiredTech === 'S' && input.required === 'N') {
    throw new HttpError(400, 'Campo de preenchimento obrigatório do sistema',
      [{ field: fieldName, message: 'Obrigatoriedade técnica — não pode ser desligada' }])
  }

  await upsertFieldConfig(
    institution.schemaName, institution.institutionId, interfaceId, fieldName, input
  )
  invalidateFieldConfig(institution.institutionId, interfaceId)
}
