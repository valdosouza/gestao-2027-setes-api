/// <reference types="jest" />
// GATE ADVERSARIAL da ONDA 0 da frente do CNPJ alfanumérico (skill `testar-adversarial.md`, 2026-10-15) — setes-api.
// Ataque que RESISTIU = teste verde que fixa a garantia. Achado CONFIRMADO = teste que FALHA hoje, marcado `[ACHADO <SEVERIDADE>]`.
// Banco MOCKADO (nenhuma escrita, nenhuma leitura real).
import { Request, Response } from 'express'
import pool from '../shared/db/connection'
import { compileCriteria, publicCriteria, SearchCriterion, MAX_CRITERIA_LENGTH } from '../shared/list'
import { CUSTOMER_SEARCH_CRITERIA } from '../modules/customers/customers.repository'
import { CARRIER_SEARCH_CRITERIA } from '../modules/carriers/carriers.repository'
import { COLLABORATOR_SEARCH_CRITERIA } from '../modules/collaborators/collaborators.repository'
import { INSTITUTION_SEARCH_CRITERIA } from '../modules/institutions/institutions.repository'
import { companyBody } from '../shared/fiscal/fiscal.dto'
import { customerCreateDto } from '../modules/customers/customers.dto'
import { carrierCreateDto } from '../modules/carriers/carriers.dto'
import { providerCreateDto } from '../modules/providers/providers.dto'
import { collaboratorCreateDto } from '../modules/collaborators/collaborators.dto'
import { institutionCreateDto, institutionUpdateDto } from '../modules/institutions/institutions.dto'
import { byDocument } from '../modules/entities/entities.controller'
import { fiscalExists } from '../modules/institutions/institutions.controller'
import * as entitiesService from '../modules/entities/entities.service'
import * as fiscalRepo from '../shared/fiscal/fiscal.repository'
import * as entity from '../shared/entity'
import { buildPayer } from '../shared/bank-slip-registration/bank-slip-registration'
import { isValidCnpj, canonicalizeFederalIdText } from '../shared/validation'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../modules/entities/entities.service', () => ({ ...jest.requireActual('../modules/entities/entities.service'), findEntityByDocument: jest.fn() }))
jest.mock('../shared/fiscal/fiscal.repository', () => ({
  ...jest.requireActual('../shared/fiscal/fiscal.repository'), findEntityIdByCpf: jest.fn(), findEntityIdByCnpj: jest.fn(),
}))
jest.mock('../shared/entity', () => ({ ...jest.requireActual('../shared/entity'), getEntityFiscalFull: jest.fn() }))

const q = (pool as any).query as jest.Mock
const DEFS: SearchCriterion[] = [{ key: 'doc', kind: 'federalId', labelKey: 'x', expr: ['p.cpf', 'c.cnpj'] }]
const crit = (v: unknown) => compileCriteria(JSON.stringify({ doc: v }), DEFS)
const fail = (v: unknown): any => { try { crit(v); return null } catch (e) { return e } }

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 5 — pesquisa `federalId` por PREFIXO
// ---------------------------------------------------------------------------------------------------------------------------------------
describe('P5 — kind federalId: injeção e metacaracteres do LIKE nunca chegam ao SQL (RESISTIU)', () => {
  it.each([
    ['%'], ['_'], ['\\'], ['12%'], ['12_34'], ['1\\%'], ["' OR 1=1 --"], ['1;DROP TABLE x'], ['12"'], ['12`'], ['12*'], ['(1)'],
    ['12ıBC'], ['ſ2'], ['１2'], ['12​3'], ['12\t3'], ['12 3'], ['\u0085 12'], ['😀'], ['12,3'], ['12+3'],
  ])('%j → 422 legível no campo, nada aplicado', v => {
    const e = fail(v)
    expect(e).toMatchObject({ statusCode: 422, fields: [expect.objectContaining({ field: 'doc' })] })
  })
  it('valor que só tem máscara, mais de 14 posições ou não é texto → 422 (nunca "sem critério" calado)', () => {
    for (const v of ['.', './-', ' . / - ', '123456789012345', '12.ABC.345/01DE-355', 123, true, ['12'], { a: 1 }]) {
      expect([v, fail(v)?.statusCode]).toEqual([v, 422])
    }
  })
  it('prefixo CANONICALIZADO vai como parâmetro (placeholder) com o curinga só no FIM; o SQL não carrega o valor', () => {
    for (const [v, p] of [['pc3d', 'PC3D%'], ['12.345.678/0001-95', '12345678000195%'], ['  00.000.000/e08g  ', '00000000E08G%'], ['529.982', '529982%']] as const) {
      const c = crit(v)
      expect(c.params).toEqual([p, p])
      expect(c.sql).toBe(' AND ((p.cpf LIKE ? OR c.cnpj LIKE ?))')
      expect(c.applied).toEqual(['doc'])
    }
  })
  it('vazio, só branco ou null = critério não informado (o mesmo do kind text) — fixa a semântica', () => {
    for (const v of ['', '   ', '　', null]) expect([v, crit(v).applied]).toEqual([v, []])
  })
  it('máscara longa dentro do teto do parâmetro vira só o prefixo (sem custo/eco do lixo)', () => {
    const v = '.'.repeat(MAX_CRITERIA_LENGTH - 40) + '1'
    expect(crit(v).params).toEqual(['1%', '1%'])
  })
})

describe('P5 — catálogo público das telas de papel: kind federalId e NENHUMA expressão (RESISTIU)', () => {
  it.each([
    ['customers', CUSTOMER_SEARCH_CRITERIA], ['carriers', CARRIER_SEARCH_CRITERIA], ['collaborators', COLLABORATOR_SEARCH_CRITERIA],
    ['institutions', INSTITUTION_SEARCH_CRITERIA],
  ] as const)('%s', (_m, defs) => {
    const pub = publicCriteria(defs)
    expect(pub.find(c => c.key === 'document')).toEqual(expect.objectContaining({ kind: 'federalId' }))
    expect(JSON.stringify(pub)).not.toMatch(/setes_central|SELECT|cnpj|cpf|expr|digits/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 5 — a porta de ESCRITA: na onda 0 era numérica; na ONDA 1 (D-CJ8, 2026-10-16) ABRIU para o CNPJ alfanumérico CANÔNICO — e só para ele
// ---------------------------------------------------------------------------------------------------------------------------------------
const cnpjIssue = (r: any, path: (string | number)[]) =>
  !r.success && r.error.issues.some((i: any) => JSON.stringify(i.path) === JSON.stringify(path))

describe('P5 — os DTOs de papel aceitam o CNPJ alfanumérico CANÔNICO e recusam o resto (minúsculo, máscara, branco, NEL) — onda 1', () => {
  const GOOD = ['PC3D315K000193', '00000000E08G12', '12345678000195']
  const BAD = ['pc3d315k000193', '12.345.678/0001-95', ' 12345678000195', '12345678000195\u0085', '12345678000199', 'PC3D315K00019Z']
  it('companyBody', () => {
    for (const cnpj of BAD) expect([cnpj, cnpjIssue(companyBody.safeParse({ cnpj }), ['cnpj'])]).toEqual([cnpj, true])
    for (const cnpj of GOOD) expect([cnpj, companyBody.safeParse({ cnpj }).success]).toEqual([cnpj, true])
    expect(isValidCnpj('PC3D315K000193')).toBe(true)
  })
  it.each([
    ['customers', customerCreateDto], ['carriers', carrierCreateDto], ['providers', providerCreateDto], ['collaborators', collaboratorCreateDto],
    ['institutions (create)', institutionCreateDto], ['institutions (update)', institutionUpdateDto],
  ] as const)('%s → issue em company.cnpj só fora da forma canônica', (_m, dto: any) => {
    for (const cnpj of BAD) {
      const r = dto.safeParse({ personType: 'J', company: { cnpj }, entity: { nameCompany: 'X' } })
      expect([cnpj, cnpjIssue(r, ['company', 'cnpj'])]).toEqual([cnpj, true])
    }
    for (const cnpj of GOOD) {
      const ok = dto.safeParse({ personType: 'J', company: { cnpj }, entity: { nameCompany: 'X' } })
      expect([cnpj, cnpjIssue(ok, ['company', 'cnpj'])]).toEqual([cnpj, false])
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 5 — leituras canonicalizam sem abrir a escrita: by-document e fiscal-exists
// ---------------------------------------------------------------------------------------------------------------------------------------
function resOf() {
  const res: any = { statusCode: 200, body: undefined }
  res.status = (c: number) => { res.statusCode = c; return res }
  res.json = (b: unknown) => { res.body = b; return res }
  return res as Response & { statusCode: number; body: any }
}
const reqOf = (query: Record<string, unknown>) => ({ query, institution: { schemaName: 'setes_setes', institutionId: 1 } }) as unknown as Request

describe('P5 — GET /api/entities/by-document', () => {
  const find = entitiesService.findEntityByDocument as jest.Mock
  beforeEach(() => { find.mockReset(); find.mockResolvedValue({ found: false }) })
  it.each([
    ['J', '12.345.678/0001-95', '12345678000195'], ['J', 'pc3d315k000193', 'PC3D315K000193'], ['J', ' 00.000.000/e08g-12 ', '00000000E08G12'],
    ['F', '529.982.247-25', '52998224725'],
  ])('%s %j → o serviço recebe a forma canônica %j (RESISTIU)', async (personType, doc, canonical) => {
    const res = resOf()
    await byDocument(reqOf({ personType, doc }), res)
    expect(res.statusCode).toBe(200)
    expect(find).toHaveBeenCalledWith(personType, canonical, 'setes_setes', 1)
  })
  it.each([
    ['J', '12ıBC34501DE35'], ['J', '3315000193'], ['J', 'PC3D315K000194'], ['J', '12ABC34501DE35\u0085'], ['J', 'PC3D315K​000193'],
    ['F', 'PC3D315K000193'], ['F', '529.982.247-2A'], ['J', ['PC3D315K000193', 'x']], ['J', { $gt: '' }], ['X', '12345678000195'],
  ])('%s %j → 400, o serviço nunca é chamado (RESISTIU)', async (personType, doc) => {
    const res = resOf()
    await byDocument(reqOf({ personType, doc }), res)
    expect(res.statusCode).toBe(400)
    expect(find).not.toHaveBeenCalled()
  })
})

describe('P5 — GET /api/institutions/fiscal-exists', () => {
  const byCnpj = fiscalRepo.findEntityIdByCnpj as jest.Mock
  const byCpf = fiscalRepo.findEntityIdByCpf as jest.Mock
  beforeEach(() => { byCnpj.mockReset(); byCpf.mockReset(); byCnpj.mockResolvedValue(null); byCpf.mockResolvedValue(null) })
  it('canonicaliza (máscara, minúscula) e consulta pela forma canônica; lixo Unicode → 400 sem consultar (RESISTIU)', async () => {
    let res = resOf(); await fiscalExists(reqOf({ cnpj: 'pc3d.315k/0001-93' }), res)
    expect([res.statusCode, byCnpj.mock.calls]).toEqual([200, [['PC3D315K000193']]])
    for (const cnpj of ['12ıBC34501DE35', 'PC3D315K000193᠎', 'PC3D315K00019３']) {
      byCnpj.mockClear(); res = resOf(); await fiscalExists(reqOf({ cnpj }), res)
      expect([cnpj, res.statusCode, byCnpj.mock.calls.length]).toEqual([cnpj, 400, 0])
    }
    res = resOf(); await fiscalExists(reqOf({ cnpj: '12345678000195', cpf: '52998224725' }), res)
    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// D-CJ10 — pagador do boleto nunca mutilado
// ---------------------------------------------------------------------------------------------------------------------------------------
const fullEntity = (over: any) => ({
  id: 900, entity: { nameCompany: 'Cliente Ltda', nickTrade: null }, person: null, company: null, noDoc: null, phones: [], socialMedia: [],
  addresses: [{ kind: 'C', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80000000', tbCountryId: 1, tbStateId: 16, tbCityId: 1, main: 'S', countryName: 'Brasil', stateName: 'Paraná', cityName: 'Curitiba' }],
  ...over,
})
describe('D-CJ10 — buildPayer: a inscrição vai como está ou não vai (RESISTIU)', () => {
  beforeEach(() => {
    q.mockReset()
    q.mockImplementation(async (sql: string) => /tb_bank_slip_title/.test(sql) ? [[{ entityId: 900 }]] : /tb_state/.test(sql) ? [[{ abbreviation: 'PR' }]] : [[]])
  })
  it.each([
    ['CPF sentinela "0" (antes ia "0" ao banco)', { person: { cpf: '0' } }, /inválido no cadastro/],
    ['CPF gravado com máscara', { person: { cpf: '529.982.247-25' } }, /inválido no cadastro/],
    ['CNPJ minúsculo', { company: { cnpj: 'pc3d315k000193' } }, /inválido no cadastro/],
    // gate socrático da onda 1: a recusa diz a SAÍDA (cancelar o boleto que não foi ao banco e cobrar por outro meio)
    ['CNPJ com 3 letras (antes: 11 dígitos como JURÍDICA)', { company: { cnpj: 'ABC12345000110' } }, /CNPJ alfanumérico.*cancele este boleto.*outro meio/],
  ])('%s → 422 BANK_PAYER_INCOMPLETE no payer.document', async (_l, over, msg) => {
    ;(entity.getEntityFiscalFull as jest.Mock).mockResolvedValue(fullEntity(over))
    const err: any = await buildPayer('setes_setes', 1, 262).then(() => null, e => e)
    expect(err).toMatchObject({ statusCode: 422, code: 'BANK_PAYER_INCOMPLETE' })
    expect(JSON.stringify(err.fields.filter((f: any) => f.field === 'payer.document'))).toMatch(msg)
  })
  it('CPF e CNPJ numéricos válidos saem intactos com o tipo do LUGAR', async () => {
    ;(entity.getEntityFiscalFull as jest.Mock).mockResolvedValue(fullEntity({ person: { cpf: '52998224725' } }))
    expect(await buildPayer('setes_setes', 1, 262)).toMatchObject({ document: '52998224725', personType: 'F' })
    ;(entity.getEntityFiscalFull as jest.Mock).mockResolvedValue(fullEntity({ company: { cnpj: '12345678000195' } }))
    expect(await buildPayer('setes_setes', 1, 262)).toMatchObject({ document: '12345678000195', personType: 'J' })
  })
})

describe('reexport do @shared/validation — a superfície é a peça do núcleo (sem cópia divergente)', () => {
  it('canonicaliza igual ao núcleo para o lixo Unicode (RESISTIU)', () => {
    for (const v of ['12ıBC', 'ſ2', '\u0085X', '᠎X', 'ﬁ']) expect([v, canonicalizeFederalIdText(v)]).toEqual([v, null])
  })
})
