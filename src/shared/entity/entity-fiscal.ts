import { z } from 'zod'
import { PoolConnection } from 'mysql2/promise'
import { EntityInput, EntityRow } from './entity.types'
import { entityBody } from './entity.dto'
import {
  nextEntityId, insertEntity, updateEntity, getEntityBase,
} from './entity.repository'
import {
  PersonType, FiscalInput, PersonRow, CompanyRow,
} from '../fiscal/fiscal.types'
import { personBody, companyBody } from '../fiscal/fiscal.dto'
import { upsertFiscal, getPerson, getCompany } from '../fiscal/fiscal.repository'
import { AddressInput, AddressRow } from '../address/address.types'
import { addressBody } from '../address/address.dto'
import { syncAddresses, listAddresses } from '../address/address.repository'
import { PhoneInput, PhoneRow } from '../phone/phone.types'
import { phoneBody } from '../phone/phone.dto'
import { syncPhones, listPhones } from '../phone/phone.repository'
import { SocialMediaInput, SocialMediaRow } from '../social-media/social-media.types'
import { socialMediaBody } from '../social-media/social-media.dto'
import { syncSocialMedia, listSocialMedia } from '../social-media/social-media.repository'

/**
 * CAMADA DE COMPOSIÇÃO da cadeia de entidade fiscal (skill
 * cadastro-entidade-fiscal.md) — o ÚNICO arquivo que importa as peças
 * (entity, fiscal, address, phone, social-media) para compor a cadeia.
 * Direção de dependência: composição → peças; as peças NUNCA importam daqui.
 *
 * A cadeia opera SEMPRE em setes_central (o schema do cliente tem só a
 * tabela concreta, FK cross-schema) — a tabela concreta é responsabilidade
 * do repository do módulo consumidor (institutions, futuros customers...).
 */

// ---------------------------------------------------------------------
// Tipos compostos
// ---------------------------------------------------------------------

/** Cadeia completa enviada no POST/PUT (person XOR company via personType). */
export interface EntityFiscalInput extends FiscalInput {
  entity:      EntityInput
  addresses:   AddressInput[]
  phones:      PhoneInput[]
  socialMedia: SocialMediaInput[]
}

/**
 * Leitura COMPLETA da cadeia (entity + fiscal + 3 listas deleted='N').
 * Os concretos estendem com seus campos (ex.: InstitutionFull acrescenta
 * schemaName/active).
 */
export interface EntityFiscalFull {
  id:          number
  entity:      EntityRow
  personType:  PersonType
  person:      PersonRow | null
  company:     CompanyRow | null
  addresses:   AddressRow[]
  phones:      PhoneRow[]
  socialMedia: SocialMediaRow[]
}

// ---------------------------------------------------------------------
// DTO composto (Zod)
// ---------------------------------------------------------------------

/**
 * Bloco fiscal completo, SEM effects — os concretos estendem daqui e
 * aplicam withFiscalRefinements POR ÚLTIMO (`.extend` não existe em
 * ZodEffects).
 */
export const entityFiscalBody = z.object({
  entity:      entityBody,
  personType:  z.enum(['F', 'J']),
  person:      personBody.nullable().optional(),
  company:     companyBody.nullable().optional(),
  addresses:   z.array(addressBody).default([]),
  phones:      z.array(phoneBody).default([]),
  socialMedia: z.array(socialMediaBody).default([]),
})

type FiscalShape = z.infer<typeof entityFiscalBody>

/** personType='F' exige person (sem company) e 'J' exige company (sem person). */
function checkFiscalToggle(data: FiscalShape, ctx: z.RefinementCtx): void {
  if (data.personType === 'F') {
    if (!data.person) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['person'],
        message: "personType='F' exige o objeto person (CPF)" })
    }
    if (data.company) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['company'],
        message: "personType='F' não aceita o objeto company" })
    }
  } else {
    if (!data.company) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['company'],
        message: "personType='J' exige o objeto company (CNPJ)" })
    }
    if (data.person) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['person'],
        message: "personType='J' não aceita o objeto person" })
    }
  }
}

/** Kind é PK junto com o id (tb_address/tb_phone/tb_social_media) — único por lista. */
function checkUniqueKinds(data: FiscalShape, ctx: z.RefinementCtx): void {
  const lists: Array<[string, Array<{ kind: string }>]> = [
    ['addresses', data.addresses],
    ['phones', data.phones],
    ['socialMedia', data.socialMedia],
  ]
  for (const [name, list] of lists) {
    const seen = new Set<string>()
    for (const item of list) {
      if (seen.has(item.kind)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name],
          message: `kind duplicado em ${name}: "${item.kind}"` })
      }
      seen.add(item.kind)
    }
  }
}

/**
 * Aplica as validações da cadeia (toggle fiscal XOR + kinds únicos) a um
 * schema que estende entityFiscalBody. SEMPRE por último no concreto.
 */
export function withFiscalRefinements<Out extends FiscalShape, In>(
  schema: z.ZodType<Out, z.ZodTypeDef, In>
): z.ZodType<Out, z.ZodTypeDef, In> {
  return schema
    .superRefine(checkFiscalToggle)
    .superRefine(checkUniqueKinds)
}

// ---------------------------------------------------------------------
// Persistência composta
// ---------------------------------------------------------------------

/**
 * Orquestra a cadeia inteira DENTRO da transação do concreto:
 * id null → INSERT (id = MAX+1 FOR UPDATE); id informado → UPDATE.
 * Devolve o id da entity. A tabela concreta (tb_institution, tb_customer...)
 * é responsabilidade do repository do módulo consumidor.
 */
export async function saveEntityFiscalChain(
  conn: PoolConnection, id: number | null, input: EntityFiscalInput
): Promise<number> {
  let entityId: number
  if (id === null) {
    entityId = await nextEntityId(conn)
    await insertEntity(conn, entityId, input.entity)
  } else {
    entityId = id
    await updateEntity(conn, entityId, input.entity)
  }
  await upsertFiscal(conn, entityId, input)
  await syncAddresses(conn, entityId, input.addresses)
  await syncPhones(conn, entityId, input.phones)
  await syncSocialMedia(conn, entityId, input.socialMedia)
  return entityId
}

/**
 * Leitura COMPLETA da cadeia (fora de transação — pool). null se a entity
 * não existe. O concreto compõe com a própria tabela.
 */
export async function getEntityFiscalFull(id: number): Promise<EntityFiscalFull | null> {
  const entity = await getEntityBase(id)
  if (!entity) return null

  const person      = await getPerson(id)
  const company     = await getCompany(id)
  const addresses   = await listAddresses(id)
  const phones      = await listPhones(id)
  const socialMedia = await listSocialMedia(id)

  return {
    id,
    entity,
    personType: person ? 'F' : 'J',
    person,
    company,
    addresses,
    phones,
    socialMedia,
  }
}
