import { InstitutionPayload } from '@shared/types/express'
import { HttpError } from '@shared/errors/http-error'
import {
  getResolvedFields, invalidateFieldConfig, findInterfaceIdByKey, ResolvedField,
} from '@shared/field-config'
import {
  InterfaceVitrineRow, listVitrine, interfaceExists, isInterfaceAcquired,
} from '@shared/interface-vitrine'
import { FieldConfigInput } from './interface-fields.interface'
import { getCatalogFieldRequired, upsertFieldConfig } from './interface-fields.repository'

/**
 * Regra do painel de campos configuráveis (decisões 2, 3 e 6 da Fase 2):
 * vitrine com todas as interfaces; campos resolvidos (inclusive travados);
 * gravação só em interface adquirida e NUNCA afrouxando o baseline técnico.
 */

export async function fetchVitrine(
  institution: InstitutionPayload, filter: string
): Promise<InterfaceVitrineRow[]> {
  return listVitrine(institution.schemaName, institution.institutionId, filter)
}

export async function fetchResolvedFields(
  institution: InstitutionPayload, interfaceId: number
): Promise<ResolvedField[]> {
  if (!(await interfaceExists(interfaceId))) {
    throw new HttpError(404, 'Interface não encontrada')
  }
  return getResolvedFields(
    institution.schemaName, institution.institutionId, interfaceId
  )
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
  if (!(await isInterfaceAcquired(
    institution.schemaName, institution.institutionId, interfaceId
  ))) {
    throw new HttpError(403, 'Interface não adquirida — configuração indisponível')
  }

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
