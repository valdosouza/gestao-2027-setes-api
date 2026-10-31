/// <reference types="jest" />
// Regressão da montagem canônica de menus (decisões 12 e 13 do Framework de
// Configurações): as duas estruturas (group_default × módulos do cliente)
// continuam exclusivas e intactas com o filtro kind='T' ativo; interface
// kind='R' (recurso/aba) NUNCA vai a menu — o filtro é feito no SQL
// (ONLY_SCREEN_KIND), então aqui garantimos (a) a montagem da árvore
// inalterada e (b) a presença do filtro em TODAS as queries de ARRANJO do repositório.
// Costura A1 da auth-api (D-AU3/D-AU6, 2026-10-31): o repositório só dá o ARRANJO; QUAIS telas e QUAIS botões vêm de UMA leitura da
// `vw_user_access` (VISUALIZAR dá o item) — o dublê `accessAnswer` responde à view a partir do perfil, do contrato e das concessões.
import fs from 'fs'
import path from 'path'
import pool from '../shared/db/connection'
import * as repo from '../modules/core/core.repository'
import { getMenus } from '../modules/core/core.service'
import { InstitutionPayload } from '../shared/types/express'
import { accessAnswer, AccessModel } from '../test-setup/access-model'

jest.mock('../modules/core/core.repository')
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))

const mockQuery         = (pool as any).query as jest.Mock
const mockModuleIfaces  = repo.getModuleInterfaces          as jest.Mock
const mockUngrouped     = repo.getUngroupedInterfaces       as jest.Mock
const mockAllCentral    = repo.getAllCentralInterfaces      as jest.Mock
const mockDelegable     = repo.getDelegableSuperInterfaces  as jest.Mock

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

const IDS = { interfaces: 3, users: 8, customers: 9 }
let models: Record<string, AccessModel>             // `${userId}:${institutionId}` → o que as views dão
beforeEach(() => {
  jest.clearAllMocks()
  models = {
    '1:1': { profile: 'super', vendor: true, interfaceIds: IDS },
    '5:7': { profile: 'admin', contracted: ['users', 'customers'], interfaceIds: IDS },
    '9:7': { profile: 'user', contracted: ['users', 'customers'], interfaceIds: IDS },
  }
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    const a = accessAnswer(sql, params, (u, i) => models[`${u}:${i}`] ?? null)
    if (a) return [a, []]
    throw new Error(`SQL inesperado: ${sql}`)
  })
  mockModuleIfaces.mockResolvedValue([])
  mockUngrouped.mockResolvedValue([])
  mockAllCentral.mockResolvedValue([])
  mockDelegable.mockResolvedValue([])
})
const accessReads = () => mockQuery.mock.calls.filter(c => /vw_user_access/.test(String(c[0])))

describe('montagem canônica preservada (decisão 12)', () => {
  it('super: catálogo central agrupado por group_default', async () => {
    mockAllCentral.mockResolvedValue([
      row({ moduleDescription: 'Super',    interfaceId: 3, interfaceDescription: 'Interfaces', i18nKey: 'interfaces' }),
      row({ moduleDescription: 'Sistema',  interfaceId: 8, interfaceDescription: 'Usuários', i18nKey: 'users' }),
    ])

    const menus = await getMenus(superPayload)
    expect(menus.map(m => m.module.description)).toEqual(['Super', 'Sistema'])
    expect(mockModuleIfaces).not.toHaveBeenCalled()
    expect(mockUngrouped).not.toHaveBeenCalled()
    expect(mockDelegable).not.toHaveBeenCalled()
  })

  it('admin: módulos do cliente + group_default, exclusivos entre si', async () => {
    mockModuleIfaces.mockResolvedValue([
      row({ moduleId: 1, moduleDescription: 'Comercial', interfaceId: 9, interfaceDescription: 'Customer', i18nKey: 'customers' }),
    ])
    mockUngrouped.mockResolvedValue([
      row({ moduleDescription: 'Sistema', interfaceId: 8, interfaceDescription: 'Usuários', i18nKey: 'users' }),
    ])

    const menus = await getMenus(adminPayload)
    expect(menus).toHaveLength(2)
    expect(menus[0].module).toMatchObject({ id: 1, description: 'Comercial' })
    expect(menus[1].module).toMatchObject({ id: null, description: 'Sistema' })
    // o arranjo é do schema (módulos do GRUPO — D-GE5); o que o usuário vê é UMA leitura da view, pela institution da sessão (D-GE4)
    expect(mockModuleIfaces).toHaveBeenCalledWith('setes_acme')
    expect(mockUngrouped).toHaveBeenCalledWith('setes_acme')
    const reads = accessReads()
    expect(reads).toHaveLength(1)
    expect(String(reads[0][0])).toMatch(/`setes_acme`\.vw_user_access/)
    expect(reads[0][1]).toEqual([5, 7])
  })

  it('regular: VISUALIZAR dá o item — sem a concessão, nada; com ela, só aquela tela (e só os verbos concedidos)', async () => {
    mockModuleIfaces.mockResolvedValue([
      row({ moduleId: 1, moduleDescription: 'Comercial', interfaceId: 9, interfaceDescription: 'Customer', i18nKey: 'customers' }),
    ])
    mockUngrouped.mockResolvedValue([
      row({ moduleDescription: 'Sistema', interfaceId: 8, interfaceDescription: 'Usuários', i18nKey: 'users' }),
    ])

    expect(await getMenus(regularPayload)).toEqual([])

    models['9:7'] = { ...models['9:7'], granted: { customers: ['VISUALIZAR', 'ALTERAR'], users: ['ALTERAR'] } }
    const menus = await getMenus(regularPayload)
    expect(menus).toHaveLength(1)
    expect(menus[0].interfaces.map(i => [i.i18nKey, i.privileges])).toEqual([['customers', ['ALTERAR', 'VISUALIZAR']]])
    expect(accessReads().map(c => c[1])).toEqual([[9, 7], [9, 7]])
  })
})

describe("filtro kind='T' nas queries de menu (decisão 13)", () => {
  it('TODAS as queries de arranjo do repositório filtram interface-tela', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/core/core.repository.ts'), 'utf-8'
    )
    // Constante única injetada nos SELECTs de menu
    expect(source).toContain(`const ONLY_SCREEN_KIND = \`AND i.kind = 'T'\``)
    for (const fn of ['getModuleInterfaces', 'getUngroupedInterfaces', 'getAllCentralInterfaces', 'getDelegableSuperInterfaces']) {
      const start = source.indexOf(`export async function ${fn}(`)
      expect(start).toBeGreaterThanOrEqual(0)
      const next = source.indexOf('\nexport ', start + 1)
      const body = source.slice(start, next < 0 ? undefined : next)
      expect({ fn, filtered: body.includes('${ONLY_SCREEN_KIND}') }).toEqual({ fn, filtered: true })
    }
  })
})
