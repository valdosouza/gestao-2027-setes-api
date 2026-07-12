/**
 * Tipos FISCAIS — tb_person (PF) × tb_company (PJ), setes_central.
 * Peça independente da cadeia (SRP/ISP): NUNCA importa a composição
 * (entity-fiscal.ts) — o vínculo é só o entityId recebido por parâmetro.
 */

export type PersonType = 'F' | 'J'

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

/** Toggle fiscal: preenche person OU company conforme personType. */
export interface FiscalInput {
  personType: PersonType
  person?:    PersonInput | null
  company?:   CompanyInput | null
}

export interface PersonRow {
  cpf:      string
  rg:       string | null
  birthday: string | null
}

export interface CompanyRow {
  cnpj:         string
  ie:           string | null
  im:           string | null
  dtFoundation: string | null
}
