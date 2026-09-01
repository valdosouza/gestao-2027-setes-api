/// <reference types="jest" />
// Módulo establishment (2026-08-26): autoatendimento do ADMIN do próprio
// institution sobre um subconjunto restrito da cadeia fiscal (@shared/
// entity). Invariante central: NUNCA existe :id de rota — o
// institutionId vem sempre de req.institution (adminGuard). Cobertura:
// GET devolve os dados do próprio institution; PUT atualiza só os campos
// permitidos; document/personType são somente leitura mesmo se enviados;
// nenhum teste depende de parâmetro de URL (não existe).
import { establishmentUpdateDto } from '../modules/establishment/establishment.dto'
import * as repo from '../modules/establishment/establishment.repository'
import { fetchEstablishment, editEstablishment } from '../modules/establishment/establishment.service'
import { EntityFiscalFull } from '@shared/entity'

jest.mock('../modules/establishment/establishment.repository')
// Peça @shared/entity-tax (D39: regime tributário do próprio emitente).
jest.mock('../shared/entity-tax/entity-tax.repository', () => ({
  getEntityTax: jest.fn().mockResolvedValue(null),
  upsertEntityTax: jest.fn().mockResolvedValue(undefined),
}))
const entityTaxRepo = require('../shared/entity-tax/entity-tax.repository')
// D42: remoção do código do regime antigo nas regras — mockada (SQL da peça
// testado em tax-rules.test); aqui interessa QUANDO o service dispara.
jest.mock('../shared/tax-rule', () => ({
  ...jest.requireActual('../shared/tax-rule'),
  clearIcmsCodesForRegime: jest.fn().mockResolvedValue(0),
}))
const taxRulePiece = require('../shared/tax-rule')

beforeEach(() => {
  jest.clearAllMocks()
  entityTaxRepo.getEntityTax.mockResolvedValue(null)
})

function fakeChainJ(): EntityFiscalFull {
  return {
    id: 5,
    entity: { nameCompany: 'Acme Ltda', nickTrade: 'Acme', aniversary: null },
    personType: 'J',
    person: null,
    company: { cnpj: '12345678000199', ie: '111222333', im: '999', dtFoundation: null },
    noDoc: null,
    addresses: [{ kind: 'main', street: 'Rua A', nmbr: '10', complement: null,
      neighborhood: 'Centro', zipCode: '01000000', tbCountryId: 1, tbStateId: 1, tbCityId: 1,
      main: 'S', countryName: 'Brasil', stateName: 'SP', cityName: 'São Paulo' }],
    phones: [{ kind: 'main', contact: 'Fulano', number: '11999998888' }],
    socialMedia: [{ kind: 'instagram', link: '@acme' }],
  }
}

function fakeChainF(): EntityFiscalFull {
  return {
    id: 6,
    entity: { nameCompany: 'Fulano de Tal', nickTrade: 'Fulano', aniversary: null },
    personType: 'F',
    person: { cpf: '12345678901', rg: null, birthday: null },
    company: null,
    noDoc: null,
    addresses: [],
    phones: [],
    socialMedia: [],
  }
}

// ---------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------

describe('establishment dto', () => {
  const base = {
    nameCompany: 'Acme Ltda',
    nickTrade: 'Acme',
    ie: null,
    im: null,
    addresses: [] as any[],
    phones: [] as any[],
    socials: [] as any[],
  }

  it('document/personType enviados no body são IGNORADOS silenciosamente (strip, não erro)', () => {
    const parsed = establishmentUpdateDto.safeParse({
      ...base, document: '12345678000199', personType: 'J',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('document')
      expect(parsed.data).not.toHaveProperty('personType')
    }
  })

  it('kind duplicado em socials é rejeitado (400)', () => {
    const parsed = establishmentUpdateDto.safeParse({
      ...base,
      socials: [{ kind: 'instagram', link: 'a' }, { kind: 'instagram', link: 'b' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('nameCompany vazio é rejeitado', () => {
    expect(establishmentUpdateDto.safeParse({ ...base, nameCompany: '' }).success).toBe(false)
  })

  it('nickTrade/ie/im aceitam null', () => {
    const parsed = establishmentUpdateDto.safeParse({ ...base, nickTrade: null })
    expect(parsed.success).toBe(true)
  })

  it('taxRegime aceita rótulo canônico, null e AUSENTE; rejeita valor fora do catálogo (D39.2/D39.4)', () => {
    expect(establishmentUpdateDto.safeParse(
      { ...base, taxRegime: '1 - Simples Nacional' }).success).toBe(true)
    expect(establishmentUpdateDto.safeParse(
      { ...base, taxRegime: null }).success).toBe(true)
    const semRegime = establishmentUpdateDto.safeParse(base)
    expect(semRegime.success).toBe(true)
    if (semRegime.success) expect(semRegime.data.taxRegime).toBeUndefined()
    expect(establishmentUpdateDto.safeParse(
      { ...base, taxRegime: 'Simples' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------

describe('establishment service', () => {
  it('fetchEstablishment devolve os dados do institution informado (personType J)', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())

    const dto = await fetchEstablishment(5, 'setes_acme')

    expect(repo.getEstablishmentChain).toHaveBeenCalledWith(5)
    expect(dto).toMatchObject({
      nameCompany: 'Acme Ltda',
      nickTrade: 'Acme',
      document: '12345678000199',
      personType: 'J',
      ie: '111222333',
      im: '999',
    })
    expect(dto.socials).toEqual([{ kind: 'instagram', link: '@acme' }])
  })

  it('fetchEstablishment devolve document=CPF e ie/im=null quando personType F', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainF())

    const dto = await fetchEstablishment(6, 'setes_acme')

    expect(dto.document).toBe('12345678901')
    expect(dto.personType).toBe('F')
    expect(dto.ie).toBeNull()
    expect(dto.im).toBeNull()
  })

  it('fetchEstablishment sem cadeia fiscal é dado inconsistente (500) — não 404: institutionId sempre vem de JWT válido', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(null)

    await expect(fetchEstablishment(999, 'setes_acme')).rejects.toMatchObject({ statusCode: 500 })
  })

  it('editEstablishment PRESERVA document/personType mesmo que o input (mal-intencionado) traga outros valores', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)

    const maliciousInput = {
      nameCompany: 'Acme Renomeada',
      nickTrade: 'Acme2',
      ie: '000111222',
      im: '333',
      addresses: [], phones: [], socials: [],
      // campos que NÃO existem no tipo EstablishmentUpdateInput — simulam
      // um body forjado que escapou do DTO por algum caminho alternativo.
      document: '00000000000000',
      personType: 'F',
    } as any

    await editEstablishment(5, 'setes_acme', maliciousInput, 42)

    expect(repo.saveEstablishmentChain).toHaveBeenCalledTimes(1)
    const [institutionId, fiscalInput] = (repo.saveEstablishmentChain as jest.Mock).mock.calls[0]
    expect(institutionId).toBe(5)
    // personType e CNPJ vêm da cadeia GRAVADA, nunca do input.
    expect(fiscalInput.personType).toBe('J')
    expect(fiscalInput.company.cnpj).toBe('12345678000199')
    // Só o subconjunto editável muda.
    expect(fiscalInput.entity.nameCompany).toBe('Acme Renomeada')
    expect(fiscalInput.company.ie).toBe('000111222')
  })

  it('editEstablishment para personType F não grava bloco company (ie/im não têm onde morar)', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainF())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)

    await editEstablishment(6, 'setes_acme', {
      nameCompany: 'Fulano Renomeado', nickTrade: null, ie: '123', im: '456',
      addresses: [], phones: [], socials: [],
    }, 1)

    const [, fiscalInput] = (repo.saveEstablishmentChain as jest.Mock).mock.calls[0]
    expect(fiscalInput.personType).toBe('F')
    expect(fiscalInput.company).toBeUndefined()
    expect(fiscalInput.person.cpf).toBe('12345678901')
    expect(fiscalInput.entity.nickTrade).toBe('') // null vira '' (entity.nickTrade não é nullable na cadeia)
  })

  it('editEstablishment repassa addresses/phones/socials do input para a cadeia (socials → socialMedia)', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)

    const newSocials = [{ kind: 'facebook', link: '/acme' }]
    await editEstablishment(5, 'setes_acme', {
      nameCompany: 'Acme Ltda', nickTrade: 'Acme', ie: '1', im: '2',
      addresses: [], phones: [], socials: newSocials,
    }, 1)

    const [, fiscalInput] = (repo.saveEstablishmentChain as jest.Mock).mock.calls[0]
    expect(fiscalInput.socialMedia).toEqual(newSocials)
    expect(fiscalInput.addresses).toEqual([])
    expect(fiscalInput.phones).toEqual([])
  })

  const baseInput = {
    nameCompany: 'Acme Ltda', nickTrade: 'Acme', ie: '1', im: '2',
    addresses: [], phones: [], socials: [],
  }

  it('fetchEstablishment devolve taxRegime da tb_entity_tax do PRÓPRIO emitente (entity = institution)', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    entityTaxRepo.getEntityTax.mockResolvedValue({ taxRegime: '1 - Simples Nacional' })

    const dto = await fetchEstablishment(5, 'setes_acme')

    expect(entityTaxRepo.getEntityTax).toHaveBeenCalledWith('setes_acme', 5, 5)
    expect(dto.taxRegime).toBe('1 - Simples Nacional')
  })

  it('editEstablishment SEM taxRegime no input NÃO toca a tributação (undefined = não mexer)', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)

    await editEstablishment(5, 'setes_acme', baseInput, 1)

    expect(entityTaxRepo.upsertEntityTax).not.toHaveBeenCalled()
  })

  it('editEstablishment com taxRegime faz MERGE sobre a linha viva (não zera os demais campos da tributação)', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)
    entityTaxRepo.getEntityTax.mockResolvedValue({
      taxRegime: '3 - Regime Normal - Lucro Real',
      issRetido: 'S', consumer: 'S',
    })

    await editEstablishment(5, 'setes_acme',
      { ...baseInput, taxRegime: '1 - Simples Nacional' }, 1)

    expect(entityTaxRepo.upsertEntityTax).toHaveBeenCalledTimes(1)
    const [, schemaName, institutionId, entityId, input] =
      entityTaxRepo.upsertEntityTax.mock.calls[0]
    expect([schemaName, institutionId, entityId]).toEqual(['setes_acme', 5, 5])
    expect(input.taxRegime).toBe('1 - Simples Nacional')
    // Campos preexistentes preservados pelo merge.
    expect(input.issRetido).toBe('S')
    expect(input.consumer).toBe('S')
  })

  it('editEstablishment com taxRegime e SEM linha prévia cria a tributação só com o regime (defaults da peça)', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)

    await editEstablishment(5, 'setes_acme',
      { ...baseInput, taxRegime: '3 - Regime Normal - Lucro Presumido' }, 1)

    const [, , , , input] = entityTaxRepo.upsertEntityTax.mock.calls[0]
    expect(input).toEqual({ taxRegime: '3 - Regime Normal - Lucro Presumido' })
  })

  // ------------------------- D42 — troca de grupo -------------------------

  it('D42: Normal -> Simples dispara a remoção do CST das regras (crt novo = 1)', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)
    entityTaxRepo.getEntityTax.mockResolvedValue({ taxRegime: '3 - Regime Normal - Lucro Real' })

    await editEstablishment(5, 'setes_acme',
      { ...baseInput, taxRegime: '1 - Simples Nacional' }, 1)

    expect(taxRulePiece.clearIcmsCodesForRegime)
      .toHaveBeenCalledWith('setes_acme', 5, '1')
  })

  it('D42: troca DENTRO do mesmo grupo (1 -> 2; Real -> Presumido) NÃO remove nada', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)

    entityTaxRepo.getEntityTax.mockResolvedValue({ taxRegime: '1 - Simples Nacional' })
    await editEstablishment(5, 'setes_acme',
      { ...baseInput, taxRegime: '2 - Simples Nacional - excesso de sublimite de receita bruta' }, 1)

    entityTaxRepo.getEntityTax.mockResolvedValue({ taxRegime: '3 - Regime Normal - Lucro Real' })
    await editEstablishment(5, 'setes_acme',
      { ...baseInput, taxRegime: '3 - Regime Normal - Lucro Presumido' }, 1)

    expect(taxRulePiece.clearIcmsCodesForRegime).not.toHaveBeenCalled()
  })

  it('D42: sem regime prévio (null) -> definir Simples também remove o CST', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)

    await editEstablishment(5, 'setes_acme',
      { ...baseInput, taxRegime: '1 - Simples Nacional' }, 1)

    expect(taxRulePiece.clearIcmsCodesForRegime)
      .toHaveBeenCalledWith('setes_acme', 5, '1')
  })

  it('D42: limpar o regime (null) ou não mandar o campo NÃO remove nada', async () => {
    (repo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)
    entityTaxRepo.getEntityTax.mockResolvedValue({ taxRegime: '1 - Simples Nacional' })

    await editEstablishment(5, 'setes_acme', { ...baseInput, taxRegime: null }, 1)
    await editEstablishment(5, 'setes_acme', baseInput, 1)

    expect(taxRulePiece.clearIcmsCodesForRegime).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------
// Controller — nenhum caminho depende de :id de rota
// ---------------------------------------------------------------------

describe('establishment controller', () => {
  // service é mockado à parte (import isolado) para o teste de contrato
  // HTTP não depender da regra de negócio real.
  const serviceModule = require('../modules/establishment/establishment.service')
  const controller = require('../modules/establishment/establishment.controller')

  function fakeRes() {
    const res: any = {}
    res.status = jest.fn().mockReturnValue(res)
    res.json = jest.fn().mockReturnValue(res)
    return res
  }

  it('GET usa req.institution.institutionId — IGNORA req.params.id mesmo se presente', async () => {
    const spy = jest.spyOn(serviceModule, 'fetchEstablishment').mockResolvedValue({ nameCompany: 'X' } as any)
    const req: any = { institution: { institutionId: 7, userId: 3, schemaName: 'setes_acme' }, params: { id: '999' } }
    const res = fakeRes()

    await controller.get(req, res)

    expect(spy).toHaveBeenCalledWith(7, 'setes_acme')
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { nameCompany: 'X' } })
    spy.mockRestore()
  })

  it('PUT usa req.institution.institutionId e o body validado (document/personType já vêm removidos)', async () => {
    const spy = jest.spyOn(serviceModule, 'editEstablishment').mockResolvedValue({ nameCompany: 'Y' } as any)
    const req: any = {
      institution: { institutionId: 7, userId: 3, schemaName: 'setes_acme' },
      params: { id: '999' }, // presente propositalmente — deve ser ignorado
      body: {
        nameCompany: 'Y', nickTrade: null, ie: null, im: null,
        addresses: [], phones: [], socials: [],
        document: '99999999999999', personType: 'F', // devem ser stripados pelo DTO
      },
    }
    const res = fakeRes()

    await controller.update(req, res)

    expect(spy).toHaveBeenCalledTimes(1)
    const [institutionId, schemaName, body, updatedBy] = spy.mock.calls[0]
    expect(institutionId).toBe(7)
    expect(schemaName).toBe('setes_acme')
    expect(body).not.toHaveProperty('document')
    expect(body).not.toHaveProperty('personType')
    expect(updatedBy).toBe(3)
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { nameCompany: 'Y' } })
    spy.mockRestore()
  })

  it('PUT com body inválido responde 400 e NUNCA chama o service', async () => {
    const spy = jest.spyOn(serviceModule, 'editEstablishment')
    const req: any = {
      institution: { institutionId: 7, userId: 3, schemaName: 'setes_acme' },
      params: {},
      body: { nameCompany: '' }, // faltam campos obrigatórios
    }
    const res = fakeRes()

    await controller.update(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
