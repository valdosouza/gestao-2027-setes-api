import { InstitutionPayload } from '@shared/types/express'
import { HttpError } from '@shared/errors/http-error'
import { isAdmin } from '@shared/auth/roles'
import {
  ResolvedConfig, getResolvedConfigs, getResolvedConfigsByKey,
  invalidateInterfaceConfig, validateConfigContent, listCatalogConfigs,
} from '@shared/interface-config'
import {
  InterfaceVitrineRow, listVitrine, interfaceExists, isInterfaceAcquired,
} from '@shared/interface-vitrine'
import { ConfigValueInput } from './interface-configs.interface'
import {
  getConfigValue, upsertConfigValue, deleteConfigValue,
} from './interface-configs.repository'

/**
 * Regra do painel de configurações (decisões 4, 7 e 9 do Framework de
 * Configurações): vitrine com todas as interfaces; configs resolvidas
 * (usuário → institution → default); gravação só em interface adquirida —
 * admin edita o valor da institution, usuário comum só o próprio override
 * de configs scope 'U'. Só grava o que DIVERGE do herdado (nota b).
 */

export async function fetchVitrine(
  institution: InstitutionPayload, filter: string
): Promise<InterfaceVitrineRow[]> {
  return listVitrine(institution.schemaName, institution.institutionId, filter)
}

export async function fetchResolvedConfigs(
  institution: InstitutionPayload, interfaceId: number
): Promise<ResolvedConfig[]> {
  if (!(await interfaceExists(interfaceId))) {
    throw new HttpError(404, 'Interface não encontrada')
  }
  return getResolvedConfigs(
    institution.schemaName, institution.institutionId, interfaceId, institution.userId
  )
}

/**
 * Config resolvida pela CHAVE do módulo — engine de consumo do app
 * (molde do field-config). Módulo sem catálogo devolve lista vazia.
 */
export async function fetchResolvedConfigsByKey(
  institution: InstitutionPayload, moduleKey: string
): Promise<ResolvedConfig[]> {
  return getResolvedConfigsByKey(institution, moduleKey)
}

export async function saveConfigValue(
  institution: InstitutionPayload, interfaceId: number,
  name: string, input: ConfigValueInput
): Promise<void> {
  if (!(await interfaceExists(interfaceId))) {
    throw new HttpError(404, 'Interface não encontrada')
  }
  if (!(await isInterfaceAcquired(
    institution.schemaName, institution.institutionId, interfaceId
  ))) {
    throw new HttpError(403, 'Interface não adquirida — configuração indisponível')
  }

  const catalog = await listCatalogConfigs(interfaceId)
  const config = catalog.find(c => c.name === name)
  if (!config) {
    throw new HttpError(404, 'Configuração não existe no catálogo desta interface')
  }

  // Decisão 4: valor da institution é do admin; override é pessoal e só
  // existe quando o catálogo autoriza (scope 'U').
  if (input.target === 'I' && !isAdmin(institution)) {
    throw new HttpError(403, 'Apenas administradores alteram o valor da institution')
  }
  if (input.target === 'U' && config.scope !== 'U') {
    throw new HttpError(403, 'Configuração não admite override por usuário')
  }

  const tbUserId = input.target === 'U' ? institution.userId : 0

  if (input.content === null) {
    await deleteConfigValue(
      institution.schemaName, institution.institutionId, interfaceId, name, tbUserId
    )
    invalidateInterfaceConfig(institution.institutionId, interfaceId)
    return
  }

  const error = validateConfigContent(config.kind, config.options, input.content)
  if (error !== null) {
    throw new HttpError(400, 'Valor inválido para a configuração',
      [{ field: name, message: error }])
  }

  // Nota b: valor só existe quando diverge do HERDADO — igualou, remove.
  const inherited = input.target === 'U'
    ? (await getConfigValue(
        institution.schemaName, institution.institutionId, interfaceId, name, 0
      )) ?? config.defaultContent
    : config.defaultContent

  if (input.content === inherited) {
    await deleteConfigValue(
      institution.schemaName, institution.institutionId, interfaceId, name, tbUserId
    )
  } else {
    await upsertConfigValue(
      institution.schemaName, institution.institutionId, interfaceId,
      name, tbUserId, input.content
    )
  }
  invalidateInterfaceConfig(institution.institutionId, interfaceId)
}
