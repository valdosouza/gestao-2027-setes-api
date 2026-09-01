import { AddressRow, AddressInput, PhoneRow, PhoneInput, SocialMediaRow, SocialMediaInput } from '@shared/entity'

/**
 * Tipos do módulo establishment — autoatendimento do ADMIN do PRÓPRIO
 * institution sobre um SUBCONJUNTO da cadeia de entidade fiscal
 * compartilhada (@shared/entity). NUNCA aceita :id de rota (elimina IDOR
 * por construção) — institutionId vem sempre de req.institution (adminGuard).
 *
 * Contrato fechado com o app (nomes exatamente como no EstablishmentDto/
 * EstablishmentUpdateDto do prompt): `socials`, não `socialMedia` — a
 * tradução para o nome interno da cadeia acontece no service.
 */

/** GET /api/establishment — document/personType são SOMENTE LEITURA. */
export interface EstablishmentDto {
  nameCompany: string
  nickTrade:   string | null
  document:    string
  personType:  'F' | 'J'
  ie:          string | null
  im:          string | null
  /** Regime tributário do PRÓPRIO estabelecimento (D39: mantido SÓ aqui) —
   *  rótulo canônico de TAX_REGIMES em tb_entity_tax (entity = institution). */
  taxRegime:   string | null
  addresses:   AddressRow[]
  phones:      PhoneRow[]
  socials:     SocialMediaRow[]
}

/**
 * PUT /api/establishment — subconjunto EDITÁVEL. document/personType
 * NUNCA aparecem aqui (o DTO Zod nem os aceita — mais estreito, não erro).
 */
export interface EstablishmentUpdateInput {
  nameCompany: string
  nickTrade:   string | null
  ie?:         string | null
  im?:         string | null
  /** Campo avulso (D39.2) — null limpa; undefined não toca a tributação. */
  taxRegime?:  string | null
  addresses:   AddressInput[]
  phones:      PhoneInput[]
  socials:     SocialMediaInput[]
}
