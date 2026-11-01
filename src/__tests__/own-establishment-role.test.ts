/// <reference types="jest" />
// D-PV32 (Valdo 2026-10-20 — prompt_privilegios_interfaces.md, fecha a Q-PV28 = (b), DIVERGIU da recomendação): o próprio
// estabelecimento PODE ser papel (cliente interno, fornecedor de si mesma), mas a CADEIA e a aba TRIBUTAÇÃO ficam SOMENTE LEITURA
// quando a entity é a institution — o emitente só se edita pelo Meu Estabelecimento. A API garante: corpo que TENTA mudar → 409
// OWN_ESTABLISHMENT_READ_ONLY (nada gravado); corpo igual → grava só a linha do papel; o GET devolve `ownEstablishment: true`.
// Antes (interino da Q-PV28, HIGH do gate da D-PV2): 409 ROLE_IS_OWN_ESTABLISHMENT na criação — SAIU.
import fs from 'fs'
import path from 'path'
import * as entityFiscal from '../shared/entity/entity-fiscal'
import * as taxRepo from '../shared/entity-tax/entity-tax.repository'
import * as fiscalRepo from '../shared/fiscal/fiscal.repository'
import {
  isOwnEstablishment, isOwnEstablishmentDocument, ownEstablishmentChanges, assertOwnEstablishmentChainUnchanged,
} from '../shared/entity/own-establishment'
import { ErrorCodes } from '../shared/errors/error-codes'
import type { EntityTaxRow, EntityTaxInput } from '../shared/entity-tax/entity-tax.types'
import type { EntityFiscalInput } from '../shared/entity/entity-fiscal'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
jest.mock('../shared/entity/entity-fiscal', () => {
  const actual = jest.requireActual('../shared/entity/entity-fiscal')
  return { __esModule: true, ...actual, getEntityFiscalFull: jest.fn() }
})
jest.mock('../shared/entity-tax/entity-tax.repository', () => ({ __esModule: true, getEntityTax: jest.fn(), upsertEntityTax: jest.fn() }))
jest.mock('../shared/fiscal/fiscal.repository', () => {
  const actual = jest.requireActual('../shared/fiscal/fiscal.repository')
  return { __esModule: true, ...actual, findEntityIdByCpf: jest.fn(), findEntityIdByCnpj: jest.fn() }
})

const full = entityFiscal.getEntityFiscalFull as jest.Mock
const getTax = taxRepo.getEntityTax as jest.Mock
const byCnpj = fiscalRepo.findEntityIdByCnpj as jest.Mock
const byCpf = fiscalRepo.findEntityIdByCpf as jest.Mock

const CURRENT = {
  id: 2, entity: { nameCompany: 'Setes LTDA', nickTrade: 'Setes', aniversary: null }, personType: 'J' as const,
  person: null, company: { cnpj: '11222333000181', ie: '123', im: '01065013677', dtFoundation: '2010-01-01' }, noDoc: null,
  addresses: [{ kind: 'C', street: 'Rua A', nmbr: '1', complement: null, neighborhood: 'Centro', zipCode: '80000000', tbCountryId: 1, tbStateId: 41, tbCityId: 4106902, main: 'S' as const, countryName: 'Brasil', stateName: 'PR', cityName: 'Curitiba' }],
  phones: [{ kind: 'C', contact: 'Valdo', number: '4199999999' }],
  socialMedia: [],
}
const CURRENT_TAX: EntityTaxRow = {
  consumer: 'N', taxRegime: '1 - Simples Nacional', simplesRegime: '2', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: null,
  cnae: null, byPassSt: 'N', indIeDest: '9', issExigibilidade: '01', issProcessNr: null, issRetido: 'N', issIndIncFiscal: 'N',
  autoSendInvoice: 'N', autoSendInvoiceJustXml: 'N',
}
export type Body = EntityFiscalInput & { tax?: EntityTaxInput | null }
/** O corpo que o app devolve depois de um GET (round trip) — nada muda */
const sameBody = (): any => ({
  entity: { nameCompany: 'Setes LTDA', nickTrade: 'Setes' }, personType: 'J' as const,
  company: { cnpj: '11222333000181', ie: '123', im: '01065013677', dtFoundation: '2010-01-01' },
  addresses: [{ kind: 'C', street: 'Rua A', nmbr: '1', complement: '', neighborhood: 'Centro', zipCode: '80000000', tbCountryId: 1, tbStateId: 41, tbCityId: 4106902, main: 'S' as const }],
  phones: [{ kind: 'C', contact: 'Valdo', number: '4199999999' }], socialMedia: [],
  tax: { ...CURRENT_TAX, simplesTotalTaxAliquot: 6.0 },
})

beforeEach(() => { jest.clearAllMocks(); full.mockResolvedValue(CURRENT); getTax.mockResolvedValue(CURRENT_TAX) })

describe('predicados', () => {
  it('isOwnEstablishment: a entity da institution; isOwnEstablishmentDocument: o documento do corpo resolve para ela (J pelo CNPJ, F pelo CPF, N nunca)', async () => {
    expect([isOwnEstablishment(2, 2), isOwnEstablishment(3, 2)]).toEqual([true, false])
    byCnpj.mockResolvedValue(2)
    expect(await isOwnEstablishmentDocument({ entity: { nameCompany: 'x', nickTrade: 'x' }, personType: 'J', company: { cnpj: '11222333000181' } }, 2)).toBe(true)
    expect(await isOwnEstablishmentDocument({ entity: { nameCompany: 'x', nickTrade: 'x' }, personType: 'J', company: { cnpj: '11222333000181' } }, 3)).toBe(false)
    byCpf.mockResolvedValue(2)
    expect(await isOwnEstablishmentDocument({ entity: { nameCompany: 'x', nickTrade: 'x' }, personType: 'F', person: { cpf: '12345678909' } }, 2)).toBe(true)
    expect(await isOwnEstablishmentDocument({ entity: { nameCompany: 'x', nickTrade: 'x' }, personType: 'N' }, 2)).toBe(false)
  })
})

describe('ownEstablishmentChanges — o que o corpo TENTA mudar', () => {
  it('round trip do GET (com normalização: "" = null, 6.0 = 6) não é mudança', () => {
    expect(ownEstablishmentChanges(sameBody(), CURRENT, CURRENT_TAX)).toEqual([])
  })
  it('cada bloco da cadeia e da tributação acusa a chave que mudou', () => {
    const b = sameBody()
    b.entity.nameCompany = 'Outro nome'; b.company.ie = '999'
    b.addresses[0].street = 'Rua B'; b.phones = []
    b.tax.simplesRegime = '1'; b.tax.simplesTotalTaxAliquot = 4
    expect(ownEstablishmentChanges(b, CURRENT, CURRENT_TAX)).toEqual([
      'entity.nameCompany', 'company.ie', 'addresses', 'phones', 'tax.simplesRegime', 'tax.simplesTotalTaxAliquot',
    ])
  })
  it('lista AUSENTE (undefined) e chave ausente não são mudança (a cadeia já trata undefined como "não tocar"); personType trocado é', () => {
    const b: any = { entity: { nameCompany: 'Setes LTDA', nickTrade: 'Setes' }, personType: 'J', company: { cnpj: '11222333000181' } }
    expect(ownEstablishmentChanges(b, CURRENT, null)).toEqual([])
    expect(ownEstablishmentChanges({ ...b, personType: 'F', person: { cpf: '12345678909' } }, CURRENT, null)).toEqual(['personType', 'person.cpf'])
  })
  it('tax ausente/null não é conferida; tax presente sem linha gravada = toda chave não nula é mudança', () => {
    expect(ownEstablishmentChanges({ ...sameBody(), tax: null }, CURRENT, null)).toEqual([])
    expect(ownEstablishmentChanges({ ...sameBody(), tax: { simplesRegime: '2', cnae: null } }, CURRENT, null)).toEqual(['tax.simplesRegime'])
  })
})

describe('assertOwnEstablishmentChainUnchanged', () => {
  it('corpo igual passa (e só lê a tributação quando o corpo a traz)', async () => {
    await expect(assertOwnEstablishmentChainUnchanged('setes_setes', 2, sameBody())).resolves.toBeUndefined()
    expect(getTax).toHaveBeenCalledWith('setes_setes', 2, 2)
    getTax.mockClear()
    await assertOwnEstablishmentChainUnchanged('setes_setes', 2, { ...sameBody(), tax: undefined })
    expect(getTax).not.toHaveBeenCalled()
  })
  it('corpo que muda a tributação do emitente → 409 OWN_ESTABLISHMENT_READ_ONLY com os campos', async () => {
    const b = sameBody(); b.tax.simplesRegime = '1'
    await expect(assertOwnEstablishmentChainUnchanged('setes_setes', 2, b)).rejects.toMatchObject({
      statusCode: 409, code: ErrorCodes.OWN_ESTABLISHMENT_READ_ONLY, fields: [{ field: 'tax.simplesRegime', message: expect.any(String) }],
    })
  })
  it('sem cadeia gravada (institution sem entity — impossível pelo onboarding) não há o que proteger', async () => {
    full.mockResolvedValue(null)
    await expect(assertOwnEstablishmentChainUnchanged('setes_setes', 2, sameBody())).resolves.toBeUndefined()
  })
})

describe('cerca: os 4 papéis com cadeia fiscal passam pela peça — na CRIAÇÃO (pelo documento, antes da transação) e na EDIÇÃO', () => {
  it.each([['customers', 'Customer', true], ['providers', 'Provider', true], ['carriers', 'Carrier', true], ['collaborators', 'Collaborator', false]])(
    '%s', (m, fn, hasTax) => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'modules', m, `${m}.repository.ts`), 'utf8')
      expect(src).not.toMatch(/assertNotOwnEstablishment|ROLE_IS_OWN_ESTABLISHMENT/)          // o 409 interino SAIU
      const body = (name: string) => {
        const i = src.indexOf(`export async function ${name}(`)
        expect([name, i >= 0]).toEqual([name, true])
        const j = src.indexOf('\nexport ', i + 1)
        return src.slice(i, j < 0 ? undefined : j)
      }
      const create = body(`insert${fn}Cascade`)
      expect(create.indexOf('isOwnEstablishmentDocument(input, institutionId)')).toBeGreaterThan(-1)
      expect(create.indexOf('assertOwnEstablishmentChainUnchanged(schemaName, institutionId, input)')).toBeLessThan(create.indexOf('pool.getConnection()'))
      expect(create).toMatch(/own \? \{ id: institutionId, reused: true \} : await saveEntityFiscalChain\(conn, null/)
      const update = body(`update${fn}Cascade`)
      expect(update.indexOf('isOwnEstablishment(id, institutionId)')).toBeGreaterThan(-1)
      expect(update.indexOf('assertOwnEstablishmentChainUnchanged(schemaName, institutionId, input)')).toBeLessThan(update.indexOf('pool.getConnection()'))
      expect(update).toMatch(/if \(!own\) await saveEntityFiscalChain\(conn, id/)
      if (hasTax) {
        expect((create.match(/if \(!own && input\.tax != null\)/g) ?? []).length).toBe(1)
        expect((update.match(/if \(!own && input\.tax != null\)/g) ?? []).length).toBe(1)
        expect(create).not.toMatch(/\n\s*if \(input\.tax != null\) \{/)
        expect(update).not.toMatch(/\n\s*if \(input\.tax != null\) \{/)
      }
      // o GET devolve o fato
      expect(src).toMatch(/ownEstablishment: isOwnEstablishment\(id, institutionId\)/)
    })
})
