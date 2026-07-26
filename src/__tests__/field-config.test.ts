/// <reference types="jest" />
// Framework de campos configuráveis (Fase 2): merge custom → catálogo
// (decisão 7) e obrigatoriedade comercial no salvar (decisões 1 e 2).
import * as repo from '../shared/field-config/field-config.repository'
import {
  getResolvedFields, invalidateFieldConfig, assertClientRequired, fieldNameToCamel,
} from '../shared/field-config/field-config.service'
import { InstitutionPayload } from '../shared/types/express'

jest.mock('../shared/field-config/field-config.repository')

const mockCatalog     = repo.listCatalogFields    as jest.Mock
const mockConfig      = repo.listFieldConfig      as jest.Mock
const mockFindByKey   = repo.findInterfaceIdByKey as jest.Mock

const institution: InstitutionPayload = {
  institutionId: 7, userId: 1, role: 'admin', schemaName: 'setes_acme',
}

beforeEach(() => {
  jest.clearAllMocks()
  invalidateFieldConfig(7, 4)
})

describe('getResolvedFields (merge custom → catálogo)', () => {
  it('técnico permanece travado; cliente aperta o opcional; caption/mask entram', async () => {
    mockCatalog.mockResolvedValue([
      { fieldName: 'id',   tableName: 'tb_country', kind: 'Integer', required: 'S' },
      { fieldName: 'name', tableName: 'tb_country', kind: 'String',  required: 'N' },
    ])
    mockConfig.mockResolvedValue([
      { fieldName: 'name', fieldCaption: 'Nome do País', required: 'S', mask: null },
    ])

    const fields = await getResolvedFields('setes_acme', 7, 4)

    expect(fields).toEqual([
      { fieldName: 'id', tableName: 'tb_country', kind: 'Integer',
        requiredTech: 'S', required: 'S', caption: null, mask: null, customized: 'N' },
      { fieldName: 'name', tableName: 'tb_country', kind: 'String',
        requiredTech: 'N', required: 'S', caption: 'Nome do País', mask: null, customized: 'S' },
    ])
  })

  it('usa cache até invalidar (decisão: molde do flag.service)', async () => {
    mockCatalog.mockResolvedValue([])
    mockConfig.mockResolvedValue([])

    await getResolvedFields('setes_acme', 7, 4)
    await getResolvedFields('setes_acme', 7, 4)
    expect(mockCatalog).toHaveBeenCalledTimes(1)

    invalidateFieldConfig(7, 4)
    await getResolvedFields('setes_acme', 7, 4)
    expect(mockCatalog).toHaveBeenCalledTimes(2)
  })
})

describe('assertClientRequired (obrigatoriedade comercial no salvar)', () => {
  it('rejeita 400 com erro por campo em camelCase quando o campo apertado falta', async () => {
    mockFindByKey.mockResolvedValue(4)
    mockCatalog.mockResolvedValue([
      { fieldName: 'aliq_iss', tableName: 'tb_city', kind: 'Float', required: 'N' },
    ])
    mockConfig.mockResolvedValue([
      { fieldName: 'aliq_iss', fieldCaption: null, required: 'S', mask: null },
    ])

    await expect(assertClientRequired(institution, 'cities', { name: 'Curitiba' }))
      .rejects.toMatchObject({
        statusCode: 400,
        fields: [{ field: 'aliqIss', message: expect.stringContaining('obrigatório') }],
      })
  })

  it('passa quando o campo apertado está preenchido', async () => {
    mockFindByKey.mockResolvedValue(4)
    mockCatalog.mockResolvedValue([
      { fieldName: 'aliq_iss', tableName: 'tb_city', kind: 'Float', required: 'N' },
    ])
    mockConfig.mockResolvedValue([
      { fieldName: 'aliq_iss', fieldCaption: null, required: 'S', mask: null },
    ])

    await expect(assertClientRequired(institution, 'cities', { aliqIss: 2.5 }))
      .resolves.toBeUndefined()
  })

  it('campo técnico NÃO é rechecado (já coberto pelo DTO Zod)', async () => {
    mockFindByKey.mockResolvedValue(4)
    mockCatalog.mockResolvedValue([
      { fieldName: 'name', tableName: 'tb_country', kind: 'String', required: 'S' },
    ])
    mockConfig.mockResolvedValue([])

    await expect(assertClientRequired(institution, 'countries', {}))
      .resolves.toBeUndefined()
  })

  it('módulo sem catálogo: nada a validar', async () => {
    mockFindByKey.mockResolvedValue(null)

    await expect(assertClientRequired(institution, 'erp', {}))
      .resolves.toBeUndefined()
    expect(mockCatalog).not.toHaveBeenCalled()
  })
})

describe('fieldNameToCamel', () => {
  it('converte snake_case da coluna para camelCase do payload', () => {
    expect(fieldNameToCamel('tb_country_id')).toBe('tbCountryId')
    expect(fieldNameToCamel('name')).toBe('name')
    expect(fieldNameToCamel('aliq_iss')).toBe('aliqIss')
  })
})
