/// <reference types="jest" />
// D-PV11 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): a tela do Super delegável entra no menu do usuário da Setes SÓ com a
// liberação do Super (VISUALIZAR marcado), e os botões dela são os privilégios que o Super marcou — nunca o catálogo, nem para o admin.
import * as repo from '../modules/core/core.repository'
import { getMenus } from '../modules/core/core.service'
import { InstitutionPayload } from '../shared/types/express'

jest.mock('../modules/core/core.repository')

const r = repo as unknown as Record<string, jest.Mock>
const row = (id: number, key: string, group = 'Vendas') => ({
  moduleId: null, moduleDescription: group, moduleIcon: null, interfaceId: id, interfaceDescription: key,
  i18nKey: key, buttonAction: null, imgIndex: null,
})
const ADMIN_SETES: InstitutionPayload = { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' }
const ADMIN_OTHER: InstitutionPayload = { institutionId: 7, userId: 30, role: 'admin', schemaName: 'setes_cliente' }

beforeEach(() => {
  jest.clearAllMocks()
  r.getModuleInterfaces.mockResolvedValue([])
  r.getUngroupedInterfaces.mockResolvedValue([row(29, 'orders')])
  r.getAllInterfacePrivileges.mockResolvedValue([
    { interfaceId: 29, privilegeId: 6, description: 'VISUALIZAR' },
    { interfaceId: 41, privilegeId: 6, description: 'VISUALIZAR' }, { interfaceId: 41, privilegeId: 2, description: 'ALTERAR' },
  ])
  r.getUserPrivileges.mockResolvedValue([{ interfaceId: 41, privilegeId: 6, description: 'VISUALIZAR' }])
  r.getDelegatedSuperInterfaces.mockResolvedValue([])
})

const flat = (menus: any[]) => menus.flatMap(m => m.interfaces.map((i: any) => [i.i18nKey, i.privileges]))

it('admin da Setes SEM a liberação: a tela delegável não aparece', async () => {
  expect(flat(await getMenus(ADMIN_SETES))).toEqual([['orders', ['VISUALIZAR']]])
  expect(r.getDelegatedSuperInterfaces).toHaveBeenCalledWith('setes_setes', 2, ['institution-interfaces'])
})

it('admin da Setes COM a liberação: a tela aparece com os privilégios QUE O SUPER MARCOU (só VISUALIZAR), não o catálogo', async () => {
  r.getDelegatedSuperInterfaces.mockResolvedValue([row(41, 'institution-interfaces', 'Super')])
  expect(flat(await getMenus(ADMIN_SETES))).toEqual([['orders', ['VISUALIZAR']], ['institution-interfaces', ['VISUALIZAR']]])
})

it('admin de OUTRO estabelecimento: nem consulta a delegação', async () => {
  await getMenus(ADMIN_OTHER)
  expect(r.getDelegatedSuperInterfaces).not.toHaveBeenCalled()
})
