import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { findEntityIdByCpf, findEntityIdByCnpj } from '@shared/fiscal/fiscal.repository'
import { getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { EntityTaxInput, EntityTaxRow } from '@shared/entity-tax/entity-tax.types'
import { EntityFiscalInput, EntityFiscalFull, getEntityFiscalFull } from './entity-fiscal'

/**
 * O PRÓPRIO estabelecimento como PAPEL (cliente interno para OS, fornecedor de si mesma…) — D-PV32 (Valdo 2026-10-20, fecha a
 * Q-PV28 = (b), DIVERGIU da recomendação): o papel PODE existir, mas a CADEIA (razão social, IE/IM, endereços, contatos) e a
 * aba TRIBUTAÇÃO ficam SOMENTE LEITURA quando a entity é a institution — o emitente só se edita pelo Meu Estabelecimento, com as
 * validações dele (D41/D-PV5, Q-N36/Q-N37). Antes (interino da Q-PV28, gate adversarial da D-PV2 — HIGH): a criação recusava com
 * 409 ROLE_IS_OWN_ESTABLISHMENT, porque o reuso pelo documento (Fase 3) resolvia o CNPJ da empresa para a entity da INSTITUTION e a
 * aba Tributação gravava a linha do EMITENTE em `tb_entity_tax` (regime do Simples, apuração, pTotTribSN — o que a nfse-api lê para
 * o DPS) por fora do Meu Estabelecimento.
 *
 * A API é quem garante (os 4 papéis com cadeia fiscal — customers, providers, carriers, collaborators):
 *   - criação/edição com a entity = institution NÃO escreve a cadeia nem `tb_entity_tax` (só a linha do PAPEL);
 *   - se o corpo TENTA mudar a cadeia ou a tributação (difere do que está gravado) → 409 OWN_ESTABLISHMENT_READ_ONLY, nada gravado;
 *   - campos PRÓPRIOS do papel (carteira, vendedor, limite, ativo…) seguem editáveis;
 *   - o GET do papel devolve `ownEstablishment: true` (o app congela os blocos — UX; a regra é da API).
 * O id da institution É o id da entity dela (`tb_institution.id = tb_entity.id`).
 * A conferência de "mudou?" lê FORA da transação do papel (nunca 2ª conexão com trava presa — regra do pool) e compara só o que o
 * corpo TROUXE (campo ausente não é mudança; lista ausente = "não tocar", como na cadeia).
 */
export function isOwnEstablishment(entityId: number, institutionId: number): boolean {
  return entityId === institutionId
}

/** Na CRIAÇÃO: o documento do corpo resolve para a entity da institution? (leitura sem trava — a identidade do emitente não muda) */
export async function isOwnEstablishmentDocument(input: EntityFiscalInput, institutionId: number): Promise<boolean> {
  if (input.personType === 'F' && input.person?.cpf) return (await findEntityIdByCpf(input.person.cpf)) === institutionId
  if (input.personType === 'J' && input.company?.cnpj) return (await findEntityIdByCnpj(input.company.cnpj)) === institutionId
  return false
}

type Scalar = string | number | null
function norm(v: unknown): Scalar {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t }
  if (typeof v === 'number') return Number(v)
  if (typeof v === 'boolean') return v ? 'S' : 'N'
  return String(v)
}

/** Compara só as chaves PRESENTES no corpo (undefined = não veio = não é mudança). */
function differs(input: Record<string, unknown> | null | undefined, current: Record<string, unknown> | null | undefined, keys: readonly string[]): string[] {
  if (!input) return []
  const out: string[] = []
  for (const k of keys) {
    if (input[k] === undefined) continue
    if (norm(input[k]) !== norm(current?.[k])) out.push(k)
  }
  return out
}

function sortedList<T>(list: readonly T[], project: (t: T) => Record<string, Scalar>): string[] {
  return list.map(t => JSON.stringify(project(t))).sort()
}
function sameList<A, B>(input: readonly A[] | undefined, current: readonly B[], pa: (a: A) => Record<string, Scalar>, pb: (b: B) => Record<string, Scalar>): boolean {
  if (input === undefined) return true                       // lista ausente = não tocar
  const a = sortedList(input, pa), b = sortedList(current, pb)
  return a.length === b.length && a.every((x, i) => x === b[i])
}

const TAX_KEYS: readonly (keyof EntityTaxRow)[] = [
  'consumer', 'taxRegime', 'simplesRegime', 'simplesAssessment', 'simplesTotalTaxAliquot', 'specialTaxRegime', 'cnae', 'byPassSt',
  'indIeDest', 'issExigibilidade', 'issProcessNr', 'issRetido', 'issIndIncFiscal', 'autoSendInvoice', 'autoSendInvoiceJustXml',
]

/** O que o corpo tenta mudar na cadeia/tributação do emitente (vazio = nada). Exportado para o teste fixar a semântica. */
export function ownEstablishmentChanges(
  input: EntityFiscalInput & { tax?: EntityTaxInput | null }, current: EntityFiscalFull, currentTax: EntityTaxRow | null
): string[] {
  const changes: string[] = []
  changes.push(...differs(input.entity as unknown as Record<string, unknown>, current.entity as unknown as Record<string, unknown>,
    ['nameCompany', 'nickTrade', 'aniversary']).map(k => `entity.${k}`))
  if (norm(input.personType) !== norm(current.personType)) changes.push('personType')
  if (input.personType === 'F') {
    changes.push(...differs(input.person as unknown as Record<string, unknown>, current.person as unknown as Record<string, unknown>,
      ['cpf', 'rg', 'birthday']).map(k => `person.${k}`))
  }
  if (input.personType === 'J') {
    changes.push(...differs(input.company as unknown as Record<string, unknown>, current.company as unknown as Record<string, unknown>,
      ['cnpj', 'ie', 'im', 'dtFoundation']).map(k => `company.${k}`))
  }
  if (!sameList(input.addresses, current.addresses,
    a => ({ kind: norm(a.kind), street: norm(a.street), nmbr: norm(a.nmbr), complement: norm(a.complement), neighborhood: norm(a.neighborhood),
      zipCode: norm(a.zipCode), tbCountryId: norm(a.tbCountryId), tbStateId: norm(a.tbStateId), tbCityId: norm(a.tbCityId), main: norm(a.main ?? 'N') }),
    a => ({ kind: norm(a.kind), street: norm(a.street), nmbr: norm(a.nmbr), complement: norm(a.complement), neighborhood: norm(a.neighborhood),
      zipCode: norm(a.zipCode), tbCountryId: norm(a.tbCountryId), tbStateId: norm(a.tbStateId), tbCityId: norm(a.tbCityId), main: norm(a.main ?? 'N') }))) {
    changes.push('addresses')
  }
  if (!sameList(input.phones, current.phones,
    p => ({ kind: norm(p.kind), contact: norm(p.contact), number: norm(p.number) }),
    p => ({ kind: norm(p.kind), contact: norm(p.contact), number: norm(p.number) }))) {
    changes.push('phones')
  }
  if (!sameList(input.socialMedia, current.socialMedia,
    m => ({ kind: norm(m.kind), link: norm(m.link) }),
    m => ({ kind: norm(m.kind), link: norm(m.link) }))) {
    changes.push('socialMedia')
  }
  if (input.tax != null) {
    changes.push(...differs(input.tax as unknown as Record<string, unknown>, (currentTax ?? {}) as unknown as Record<string, unknown>,
      TAX_KEYS as readonly string[]).map(k => `tax.${k}`))
  }
  return changes
}

/**
 * 409 OWN_ESTABLISHMENT_READ_ONLY se o corpo tenta mudar a cadeia ou a tributação do emitente; senão nada (o chamador então
 * PULA a escrita da cadeia e da tributação e grava só a linha do papel). Lê pelo pool — chamar ANTES de abrir a transação.
 */
export async function assertOwnEstablishmentChainUnchanged(
  schemaName: string, institutionId: number, input: EntityFiscalInput & { tax?: EntityTaxInput | null }
): Promise<void> {
  const current = await getEntityFiscalFull(institutionId)
  if (!current) return                                        // sem cadeia gravada não há o que proteger (o emitente nasce no onboarding)
  const currentTax = input.tax != null ? await getEntityTax(schemaName, institutionId, institutionId) : null
  const changes = ownEstablishmentChanges(input, current, currentTax)
  if (changes.length === 0) return
  throw new HttpError(409,
    'Esta entidade é o próprio estabelecimento — os dados da empresa e a tributação se editam em Meu Estabelecimento; aqui só os campos do papel',
    changes.map(field => ({ field, message: 'Somente leitura (próprio estabelecimento)' })), ErrorCodes.OWN_ESTABLISHMENT_READ_ONLY)
}
