import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { EntityFiscalFull, EntityFiscalInput } from '@shared/entity'
import { getEntityTax, upsertEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { parseCrt } from '@shared/entity-tax/entity-tax.types'
import { crtGroup, clearIcmsCodesForRegime } from '@shared/tax-rule'
import logger from '@shared/logger/logger'
import { EstablishmentDto, EstablishmentUpdateInput } from './establishment.interface'
import { getEstablishmentChain, saveEstablishmentChain } from './establishment.repository'

/**
 * Regra do módulo establishment — SEM 404 de "não encontrado": o
 * institutionId sempre vem de um JWT válido (adminGuard), logo o
 * institution SEMPRE existe. Se a cadeia fiscal não existir mesmo assim,
 * é dado inconsistente (500), não um caso de uso normal.
 *
 * document/personType são SOMENTE LEITURA por construção: o DTO nem os
 * aceita no PUT — o service preserva o que já está gravado (CPF/CNPJ e o
 * toggle F/J/N nunca mudam por aqui).
 */

function toDto(chain: EntityFiscalFull, taxRegime: string | null): EstablishmentDto {
  // Institution sempre nasce com documento (F ou J) — nunca 'N' (decisão
  // registrada no institutionCreateDto: schemaName + admin obrigatórios,
  // e a criação real do cliente é sempre pessoa física ou jurídica). Se um
  // dado legado/corrompido chegar como 'N', é inconsistência de dado — 500.
  if (chain.personType === 'N') {
    throw new HttpError(500,
      `Estabelecimento ${chain.id} sem documento fiscal (personType 'N') — dado inconsistente`)
  }
  const personType = chain.personType
  return {
    nameCompany: chain.entity.nameCompany ?? '',
    nickTrade:   chain.entity.nickTrade,
    document:    personType === 'F' ? chain.person!.cpf : chain.company!.cnpj,
    personType,
    ie:          chain.company?.ie ?? null,
    im:          chain.company?.im ?? null,
    taxRegime,
    addresses:   chain.addresses,
    phones:      chain.phones,
    socials:     chain.socialMedia,
  }
}

export async function fetchEstablishment(
  institutionId: number, schemaName: string
): Promise<EstablishmentDto> {
  const chain = await getEstablishmentChain(institutionId)
  if (!chain) {
    throw new HttpError(500,
      `Estabelecimento ${institutionId} sem cadeia de entidade fiscal — dado inconsistente`)
  }
  // Tributação do PRÓPRIO estabelecimento (convenção R4 do faturamento:
  // tb_institution.id = tb_entity.id) — null se nunca configurada.
  const tax = await getEntityTax(schemaName, institutionId, institutionId)
  return toDto(chain, tax?.taxRegime ?? null)
}

export async function editEstablishment(
  institutionId: number, schemaName: string,
  input: EstablishmentUpdateInput, updatedBy: number | null
): Promise<EstablishmentDto> {
  const chain = await getEstablishmentChain(institutionId)
  if (!chain) {
    throw new HttpError(500,
      `Estabelecimento ${institutionId} sem cadeia de entidade fiscal — dado inconsistente`)
  }
  if (chain.personType === 'N') {
    throw new HttpError(500,
      `Estabelecimento ${institutionId} sem documento fiscal (personType 'N') — dado inconsistente`)
  }

  // Reconstitui a cadeia completa que saveEntityFiscalChain espera,
  // preservando o que é SOMENTE LEITURA (documento e o toggle F/J) e
  // aplicando só o subconjunto editável do contrato.
  const fiscalInput: EntityFiscalInput = {
    entity: {
      nameCompany: input.nameCompany,
      nickTrade:   input.nickTrade ?? '',
      aniversary:  chain.entity.aniversary,
    },
    personType: chain.personType,
    person: chain.personType === 'F'
      ? { cpf: chain.person!.cpf, rg: chain.person!.rg, birthday: chain.person!.birthday }
      : undefined,
    company: chain.personType === 'J'
      ? { cnpj: chain.company!.cnpj, ie: input.ie ?? null, im: input.im ?? null,
          dtFoundation: chain.company!.dtFoundation }
      : undefined,
    addresses:   input.addresses,
    phones:      input.phones,
    socialMedia: input.socials,
  }

  await saveEstablishmentChain(institutionId, fiscalInput, updatedBy)

  // Regime tributário (D39.2 — campo avulso): undefined = não tocar a
  // tributação; presente = MERGE sobre a linha viva (upsertEntityTax grava
  // TODAS as colunas — sem o merge, um PUT daqui zeraria o que a aba
  // Tributação de outros cadastros tivesse configurado para o emitente).
  if (input.taxRegime !== undefined) {
    const current = await getEntityTax(schemaName, institutionId, institutionId)
    await upsertEntityTax(pool, schemaName, institutionId, institutionId, {
      ...(current ?? {}),
      taxRegime: input.taxRegime,
    })

    // D42: mudou o GRUPO do regime (Simples 1/2 × Normal 3) → remove das
    // regras de tributação o código do regime que ficou para trás (indo p/
    // Simples zera CST; indo p/ Normal zera CSOSN). As regras ficam
    // incompletas de propósito: o /billing/validate acusa e força a revisão
    // (o app avisa ANTES de salvar). Trocas dentro do mesmo grupo (1↔2,
    // Real↔Presumido) e limpeza p/ null não removem nada.
    const oldGroup = crtGroup(parseCrt(current?.taxRegime))
    const newCrt = parseCrt(input.taxRegime)
    const newGroup = crtGroup(newCrt)
    if (newGroup !== null && newGroup !== oldGroup) {
      const affected = await clearIcmsCodesForRegime(schemaName, institutionId, newCrt!)
      logger.info('Regime tributário alterado — códigos ICMS removidos das regras', {
        schemaName, institutionId, newGroup, rulesAffected: affected,
      })
    }
  }
  return fetchEstablishment(institutionId, schemaName)
}
