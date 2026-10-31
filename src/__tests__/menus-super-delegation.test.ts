/// <reference types="jest" />
// D-PV11 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): a tela do Super delegável entra no menu do usuário da Setes SÓ com a
// liberação do Super (VISUALIZAR marcado), e os botões dela são os privilégios que o Super marcou — nunca o catálogo, nem para o admin.
// Costura A1 da auth-api (D-AU6, 2026-10-31): o repositório dá só o ARRANJO da tela delegável; quem decide se ela aparece (e com quais
// botões) é a `vw_user_access` — respondida aqui pelo dublê `accessAnswer` (delegável: só com `vendor` e só pela concessão).
import pool from '../shared/db/connection'
import * as repo from '../modules/core/core.repository'
import { getMenus } from '../modules/core/core.service'
import { InstitutionPayload } from '../shared/types/express'
import { accessAnswer, AccessModel } from '../test-setup/access-model'

jest.mock('../modules/core/core.repository')
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))

const mockQuery = (pool as any).query as jest.Mock
const r = repo as unknown as Record<string, jest.Mock>
const row = (id: number, key: string, group = 'Vendas') => ({
  moduleId: null, moduleDescription: group, moduleIcon: null, interfaceId: id, interfaceDescription: key,
  i18nKey: key, buttonAction: null, imgIndex: null,
})
const ADMIN_SETES: InstitutionPayload = { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' }
const ADMIN_OTHER: InstitutionPayload = { institutionId: 7, userId: 30, role: 'admin', schemaName: 'setes_cliente' }

// catálogo: orders com VISUALIZAR; a delegável com VISUALIZAR e ALTERAR registrados
const REGISTERED = { orders: ['VISUALIZAR'], 'institution-interfaces': ['VISUALIZAR', 'ALTERAR'] }
const IDS = { orders: 29, 'institution-interfaces': 41 }
let models: Record<string, AccessModel>

beforeEach(() => {
  jest.clearAllMocks()
  models = {
    '2:1': { profile: 'admin', vendor: true, contracted: ['orders'], registered: REGISTERED, interfaceIds: IDS },
    '30:7': { profile: 'admin', vendor: false, contracted: ['orders'], registered: REGISTERED, interfaceIds: IDS },
  }
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    const a = accessAnswer(sql, params, (u, i) => models[`${u}:${i}`] ?? null)
    if (a) return [a, []]
    throw new Error(`SQL inesperado: ${sql}`)
  })
  r.getModuleInterfaces.mockResolvedValue([])
  r.getUngroupedInterfaces.mockResolvedValue([row(29, 'orders')])
  r.getDelegableSuperInterfaces.mockResolvedValue([row(41, 'institution-interfaces', 'Super')])
})

const flat = (menus: any[]) => menus.flatMap(m => m.interfaces.map((i: any) => [i.i18nKey, i.privileges]))

it('admin da Setes SEM a liberação: a tela delegável não aparece (o admin não passa o verbo da delegável)', async () => {
  expect(flat(await getMenus(ADMIN_SETES))).toEqual([['orders', ['VISUALIZAR']]])
  expect(r.getDelegableSuperInterfaces).toHaveBeenCalledWith(['institution-interfaces'])
})

it('admin da Setes COM a liberação: a tela aparece com os privilégios QUE O SUPER MARCOU (só VISUALIZAR), não o catálogo', async () => {
  models['2:1'] = { ...models['2:1'], granted: { 'institution-interfaces': ['VISUALIZAR'] } }
  expect(flat(await getMenus(ADMIN_SETES))).toEqual([['orders', ['VISUALIZAR']], ['institution-interfaces', ['VISUALIZAR']]])
})

it('admin de OUTRO estabelecimento: a delegável nunca aparece — nem com a concessão gravada (a view não a alcança fora da Setes)', async () => {
  models['30:7'] = { ...models['30:7'], granted: { 'institution-interfaces': ['VISUALIZAR', 'ALTERAR'] } }
  expect(flat(await getMenus(ADMIN_OTHER))).toEqual([['orders', ['VISUALIZAR']]])
})
