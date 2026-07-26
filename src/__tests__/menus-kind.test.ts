/// <reference types="jest" />
// Regressão da montagem canônica de menus (decisões 12 e 13 do Framework de
// Configurações): as duas estruturas (group_default × módulos do cliente)
// continuam exclusivas e intactas com o filtro kind='T' ativo; interface
// kind='R' (recurso/aba) NUNCA vai a menu — o filtro é feito no SQL
// (ONLY_SCREEN_KIND), então aqui garantimos (a) a montagem da árvore
// inalterada e (b) a presença do filtro nas TRÊS queries do repositório.
import fs from 'fs'
import path from 'path'
import * as repo from '../modules/core/core.repository'
import { getMenus } from '../modules/core/core.service'
import { InstitutionPayload } from '../shared/types/express'

jest.mock('../modules/core/core.repository')

const mockModuleIfaces  = repo.getModuleInterfaces      as jest.Mock
const mockUngrouped     = repo.getUngroupedInterfaces   as jest.Mock
const mockUserPrivs     = repo.getUserPrivileges        as jest.Mock
const mockAllPrivs      = repo.getAllInterfacePrivileges as jest.Mock
const mockAllCentral    = repo.getAllCentralInterfaces  as jest.Mock

const superPayload: InstitutionPayload = {
  institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes',
}
const adminPayload: InstitutionPayload = {
  institutionId: 7, userId: 5, role: 'admin', schemaName: 'setes_acme',
}
const regularPayload: InstitutionPayload = {
  institutionId: 7, userId: 9, role: 'user', schemaName: 'setes_acme',
}

const row = (over: Partial<repo.MenuInterfaceRow>): repo.MenuInterfaceRow => ({
  moduleId: null, moduleDescription: null, moduleIcon: null,
  interfaceId: 0, interfaceDescription: null, i18nKey: null,
  buttonAction: null, imgIndex: null, ...over,
})

beforeEach(() => jest.clearAllMocks())

describe('montagem canônica preservada (decisão 12)', () => {
  it('super: catálogo central agrupado por group_default', async () => {
    mockAllCentral.mockResolvedValue([
      row({ moduleDescription: 'Super',    interfaceId: 3, interfaceDescription: 'Interfaces' }),
      row({ moduleDescription: 'Sistema',  interfaceId: 8, interfaceDescription: 'Usuários' }),
    ])
    mockAllPrivs.mockResolvedValue([])

    const menus = await getMenus(superPayload)
    expect(menus.map(m => m.module.description)).toEqual(['Super', 'Sistema'])
    expect(mockModuleIfaces).not.toHaveBeenCalled()
  })

  it('admin: módulos do cliente + group_default, exclusivos entre si', async () => {
    mockModuleIfaces.mockResolvedValue([
      row({ moduleId: 1, moduleDescription: 'Comercial', interfaceId: 9, interfaceDescription: 'Customer' }),
    ])
    mockUngrouped.mockResolvedValue([
      row({ moduleDescription: 'Sistema', interfaceId: 8, interfaceDescription: 'Usuários' }),
    ])
    mockAllPrivs.mockResolvedValue([])

    const menus = await getMenus(adminPayload)
    expect(menus).toHaveLength(2)
    expect(menus[0].module).toMatchObject({ id: 1, description: 'Comercial' })
    expect(menus[1].module).toMatchObject({ id: null, description: 'Sistema' })
    // admin pula o filtro de privilégio (skipPrivilegeFilter = true)
    expect(mockModuleIfaces).toHaveBeenCalledWith('setes_acme', 5, true)
  })

  it('regular: filtro de privilégio VISUALIZAR ativo', async () => {
    mockModuleIfaces.mockResolvedValue([])
    mockUngrouped.mockResolvedValue([])
    mockUserPrivs.mockResolvedValue([])

    const menus = await getMenus(regularPayload)
    expect(menus).toEqual([])
    expect(mockModuleIfaces).toHaveBeenCalledWith('setes_acme', 9, false)
    expect(mockAllPrivs).not.toHaveBeenCalled()
  })
})

describe("filtro kind='T' nas queries de menu (decisão 13)", () => {
  it('as TRÊS queries do repositório filtram interface-tela', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/core/core.repository.ts'), 'utf-8'
    )
    // Constante única injetada nos três SELECTs de menu
    expect(source).toContain(`const ONLY_SCREEN_KIND = \`AND i.kind = 'T'\``)
    const uses = source.match(/\$\{ONLY_SCREEN_KIND\}/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(3)
  })
})
