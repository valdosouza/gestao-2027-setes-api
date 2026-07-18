import { HttpError } from '@shared/errors/http-error'
import { getEntityFiscalFull, EntityFiscalFull } from '@shared/entity'
import { findEntityIdByCpf, findEntityIdByCnpj } from '@shared/fiscal/fiscal.repository'
import { getEntityBase } from '@shared/entity/entity.repository'
import { upsertEntityTax, getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { EntityTaxInput, EntityTaxRow } from '@shared/entity-tax/entity-tax.types'
import pool from '@shared/db/connection'
import { listEntityRoles } from './entities.repository'

/**
 * Busca por documento (Fase 3 Entidade Única, decisões 3, 9 e 10): serve o
 * PREFILL do app — ao digitar um CPF/CNPJ já conhecido, o cadastro vem
 * preenchido usando o tb_entity.id existente ("a beleza de não ter dados
 * duplicados"). É só UX: a resolução DEFINITIVA acontece de novo dentro da
 * transação do salvar (saveEntityFiscalChain — o app nunca manda entityId).
 */

export interface EntityByDocumentResult {
  found:   boolean
  entity?: EntityFiscalFull
  roles?:  string[]
}

export async function findEntityByDocument(
  personType: 'F' | 'J', doc: string, schemaName: string, institutionId: number
): Promise<EntityByDocumentResult> {
  const entityId = personType === 'F'
    ? await findEntityIdByCpf(doc)
    : await findEntityIdByCnpj(doc)
  if (entityId === null) return { found: false }

  const entity = await getEntityFiscalFull(entityId)
  if (!entity) return { found: false }

  const roles = await listEntityRoles(entityId, schemaName, institutionId)
  return { found: true, entity, roles }
}

/**
 * Tributação AVULSA da relação entity × institution (Fase 3 Rodada 4,
 * decisão 17): qualquer entidade pode precisar de tributação para receber
 * notas — os papéis (customer hoje) salvam a aba junto no próprio POST/PUT;
 * estes endpoints servem papéis futuros e ajustes diretos.
 */
export async function fetchEntityTax(
  entityId: number, schemaName: string, institutionId: number
): Promise<EntityTaxRow | null> {
  if (!(await getEntityBase(entityId))) {
    throw new HttpError(404, `Entidade ${entityId} não encontrada`)
  }
  return getEntityTax(schemaName, institutionId, entityId)
}

export async function saveEntityTax(
  entityId: number, input: EntityTaxInput, schemaName: string, institutionId: number
): Promise<void> {
  if (!(await getEntityBase(entityId))) {
    throw new HttpError(404, `Entidade ${entityId} não encontrada`)
  }
  await upsertEntityTax(pool, schemaName, institutionId, entityId, input)
}
