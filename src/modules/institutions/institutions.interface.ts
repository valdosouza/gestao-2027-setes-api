/**
 * Tipos do módulo institutions (tb_institution + cadeia de entidade fiscal
 * na setes_central — skill cadastro-entidade-fiscal.md).
 * Espelho no app: apps/web/lib/app/modules/institutions/domain/entity/object_institution.dart
 * (cadeia base em apps/web/lib/app/shared/entity/domain/).
 */

export type PersonType = 'F' | 'J'

// ---------------------------------------------------------------------
// Fatias da cadeia (entrada — shape camelCase que o app envia)
// ---------------------------------------------------------------------

export interface EntityInput {
  nameCompany: string
  nickTrade:   string
  /** Data no formato YYYY-MM-DD. */
  aniversary?: string | null
}

export interface PersonInput {
  cpf:       string
  rg?:       string | null
  birthday?: string | null
}

export interface CompanyInput {
  cnpj:          string
  ie?:           string | null
  im?:           string | null
  dtFoundation?: string | null
}

export interface AddressInput {
  kind:          string
  street:        string
  nmbr?:         string | null
  complement?:   string | null
  neighborhood?: string | null
  zipCode?:      string | null
  tbCountryId:   number
  tbStateId:     number
  tbCityId:      number
  main?:         'S' | 'N'
}

export interface PhoneInput {
  kind:     string
  contact?: string | null
  number?:  string | null
}

export interface SocialMediaInput {
  kind:  string
  link?: string | null
}

/** Cadeia completa enviada no POST/PUT (person XOR company via personType). */
export interface InstitutionInput {
  entity:      EntityInput
  personType:  PersonType
  person?:     PersonInput | null
  company?:    CompanyInput | null
  addresses:   AddressInput[]
  phones:      PhoneInput[]
  socialMedia: SocialMediaInput[]
  active?:     'S' | 'N'
}

// ---------------------------------------------------------------------
// Saída (shape camelCase que o app consome)
// ---------------------------------------------------------------------

/** Linha da pesquisa (GET /api/institutions). */
export interface InstitutionListRow {
  id:          number
  nickTrade:   string | null
  nameCompany: string | null
  schemaName:  string
  active:      'S' | 'N' | null
}

export interface AddressRow {
  kind:         string
  street:       string | null
  nmbr:         string | null
  complement:   string | null
  neighborhood: string | null
  zipCode:      string | null
  tbCountryId:  number
  tbStateId:    number
  tbCityId:     number
  main:         'S' | 'N'
  /** Nomes via JOIN — exibição nos lookups do app (campo-lookup-fk.md). */
  countryName:  string | null
  stateName:    string | null
  cityName:     string | null
}

export interface PhoneRow {
  kind:    string
  contact: string | null
  number:  string | null
}

export interface SocialMediaRow {
  kind: string
  link: string | null
}

/** Objeto COMPLETO devolvido no GET /api/institutions/:id. */
export interface InstitutionFull {
  id:          number
  entity: {
    nameCompany: string | null
    nickTrade:   string | null
    aniversary:  string | null
  }
  personType:  PersonType
  person:      { cpf: string; rg: string | null; birthday: string | null } | null
  company:     { cnpj: string; ie: string | null; im: string | null; dtFoundation: string | null } | null
  addresses:   AddressRow[]
  phones:      PhoneRow[]
  socialMedia: SocialMediaRow[]
  schemaName:  string
  active:      'S' | 'N' | null
}
