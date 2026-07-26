/// <reference types="jest" />
// Framework de Configurações do Sistema: resolução usuário → institution →
// default (decisão 4), cache TTL (molde field-config) e validação por kind
// (decisão 6) — prompt_framework_configuracoes_sistema.md.
import * as repo from '../shared/interface-config/interface-config.repository'
import {
  getResolvedConfigs, getResolvedConfigsByKey, getConfigContent,
  invalidateInterfaceConfig, invalidateInterfaceConfigCatalog,
  parseConfigOptions, validateConfigContent,
} from '../shared/interface-config/interface-config.service'
import * as fieldConfigRepo from '../shared/field-config/field-config.repository'
import { InstitutionPayload } from '../shared/types/express'

jest.mock('../shared/interface-config/interface-config.repository')
jest.mock('../shared/field-config/field-config.repository')

const mockCatalog   = repo.listCatalogConfigs as jest.Mock
const mockValues    = repo.listConfigValues   as jest.Mock
const mockFindByKey = fieldConfigRepo.findInterfaceIdByKey as jest.Mock

const institution: InstitutionPayload = {
  institutionId: 7, userId: 42, role: 'user', schemaName: 'setes_acme',
}

const CATALOG = [
  { name: 'default_person_type', description: 'Predominância PF/PJ', kind: 'Options',
    options: 'F=Pessoa Física;J=Pessoa Jurídica', defaultContent: 'J', scope: 'U' },
  { name: 'restrict_customer_to_salesman', description: 'Carteira do vendedor',
    kind: 'Boolean', options: null, defaultContent: 'N', scope: 'I' },
]

beforeEach(() => {
  jest.clearAllMocks()
  invalidateInterfaceConfigCatalog(9)
})

describe('getResolvedConfigs (usuário → institution → default — decisão 4)', () => {
  it('sem valor gravado vale o default do catálogo', async () => {
    mockCatalog.mockResolvedValue(CATALOG)
    mockValues.mockResolvedValue([])

    const configs = await getResolvedConfigs('setes_acme', 7, 9, 42)

    expect(configs.find(c => c.name === 'default_person_type')).toMatchObject({
      institutionContent: null, userContent: null, content: 'J',
    })
    expect(configs.find(c => c.name === 'restrict_customer_to_salesman')).toMatchObject({
      content: 'N',
    })
  })

  it('valor da institution (tb_user_id=0) cobre o default', async () => {
    mockCatalog.mockResolvedValue(CATALOG)
    mockValues.mockResolvedValue([
      { name: 'default_person_type', tbUserId: 0, content: 'F' },
    ])

    const configs = await getResolvedConfigs('setes_acme', 7, 9, 42)

    expect(configs.find(c => c.name === 'default_person_type')).toMatchObject({
      institutionContent: 'F', userContent: null, content: 'F',
    })
  })

  it('override do usuário cobre institution e default (scope U)', async () => {
    mockCatalog.mockResolvedValue(CATALOG)
    mockValues.mockResolvedValue([
      { name: 'default_person_type', tbUserId: 0,  content: 'F' },
      { name: 'default_person_type', tbUserId: 42, content: 'J' },
    ])

    const configs = await getResolvedConfigs('setes_acme', 7, 9, 42)

    expect(configs.find(c => c.name === 'default_person_type')).toMatchObject({
      institutionContent: 'F', userContent: 'J', content: 'J',
    })
  })

  it('override de usuário em config scope I é IGNORADO na resolução', async () => {
    mockCatalog.mockResolvedValue(CATALOG)
    mockValues.mockResolvedValue([
      { name: 'restrict_customer_to_salesman', tbUserId: 42, content: 'S' },
    ])

    const configs = await getResolvedConfigs('setes_acme', 7, 9, 42)

    expect(configs.find(c => c.name === 'restrict_customer_to_salesman')).toMatchObject({
      userContent: null, content: 'N',
    })
  })

  it('usa cache até invalidar (molde do field-config)', async () => {
    mockCatalog.mockResolvedValue(CATALOG)
    mockValues.mockResolvedValue([])

    await getResolvedConfigs('setes_acme', 7, 9, 42)
    await getResolvedConfigs('setes_acme', 7, 9, 42)
    expect(mockCatalog).toHaveBeenCalledTimes(1)

    invalidateInterfaceConfig(7, 9)
    await getResolvedConfigs('setes_acme', 7, 9, 42)
    expect(mockCatalog).toHaveBeenCalledTimes(2)
  })

  it('cache é por usuário: outro userId não herda o override do primeiro', async () => {
    mockCatalog.mockResolvedValue(CATALOG)
    mockValues.mockResolvedValueOnce([
      { name: 'default_person_type', tbUserId: 42, content: 'F' },
    ]).mockResolvedValueOnce([])

    const doUser   = await getResolvedConfigs('setes_acme', 7, 9, 42)
    const doOutro  = await getResolvedConfigs('setes_acme', 7, 9, 99)

    expect(doUser.find(c => c.name === 'default_person_type')!.content).toBe('F')
    expect(doOutro.find(c => c.name === 'default_person_type')!.content).toBe('J')
  })
})

describe('getResolvedConfigsByKey / getConfigContent (consumo por módulo)', () => {
  it('módulo sem interface no catálogo devolve lista vazia', async () => {
    mockFindByKey.mockResolvedValue(null)
    await expect(getResolvedConfigsByKey(institution, 'erp')).resolves.toEqual([])
  })

  it('getConfigContent devolve o valor efetivo (e null p/ config inexistente)', async () => {
    mockFindByKey.mockResolvedValue(9)
    mockCatalog.mockResolvedValue(CATALOG)
    mockValues.mockResolvedValue([
      { name: 'restrict_customer_to_salesman', tbUserId: 0, content: 'S' },
    ])

    await expect(getConfigContent(institution, 'customers', 'restrict_customer_to_salesman'))
      .resolves.toBe('S')
    await expect(getConfigContent(institution, 'customers', 'nao_existe'))
      .resolves.toBeNull()
  })
})

describe('parseConfigOptions / validateConfigContent (decisão 6)', () => {
  it('separa a lista fechada de Options', () => {
    expect(parseConfigOptions('F=Pessoa Física;J=Pessoa Jurídica')).toEqual([
      { value: 'F', label: 'Pessoa Física' },
      { value: 'J', label: 'Pessoa Jurídica' },
    ])
    expect(parseConfigOptions(null)).toEqual([])
  })

  it('valida content por kind', () => {
    expect(validateConfigContent('Integer', null, '42')).toBeNull()
    expect(validateConfigContent('Integer', null, '4.2')).not.toBeNull()
    expect(validateConfigContent('Float', null, '4.2')).toBeNull()
    expect(validateConfigContent('Boolean', null, 'S')).toBeNull()
    expect(validateConfigContent('Boolean', null, 'X')).not.toBeNull()
    expect(validateConfigContent('Date', null, '2026-07-17')).toBeNull()
    expect(validateConfigContent('Date', null, '17/07/2026')).not.toBeNull()
    expect(validateConfigContent('Options', 'C=Consumidor;R=Revenda', 'R')).toBeNull()
    expect(validateConfigContent('Options', 'C=Consumidor;R=Revenda', 'X')).not.toBeNull()
    expect(validateConfigContent('String', null, 'qualquer coisa')).toBeNull()
  })
})
