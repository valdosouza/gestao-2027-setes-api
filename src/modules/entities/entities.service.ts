import { getEntityFiscalFull, EntityFiscalFull } from '@shared/entity'
import { findEntityIdByCpf, findEntityIdByCnpj } from '@shared/fiscal/fiscal.repository'
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

// D-PV23/D-PV30 (2026-10-20): `fetchEntityTax`/`saveEntityTax` (tributação AVULSA — Fase 3 Rodada 4, decisão 17) SAÍRAM com as rotas:
// a tributação da relação se grava na transação do PAPEL (aba Tributação) e a do emitente pelo Meu Estabelecimento.
