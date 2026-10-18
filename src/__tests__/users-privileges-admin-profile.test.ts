/// <reference types="jest" />
// D-PV5 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): o cadastro de privilégios do usuário NÃO oferece as telas
// do perfil admin (users, establishment) — a listagem as tira no SQL, pela lista nomeada.
import pool from '../shared/db/connection'
import { listUserPrivileges } from '../modules/users/users.repository'
import { ADMIN_PROFILE_INTERFACE_KEYS } from '../modules/users/users.service'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock

it('a lista do cadastro de privilégios exclui users e establishment (parâmetro da lista nomeada)', async () => {
  mockQuery.mockResolvedValue([[]])
  await listUserPrivileges('setes_acme', 5, 9, ADMIN_PROFILE_INTERFACE_KEYS)
  const [sql, params] = mockQuery.mock.calls[0]
  expect(String(sql)).toMatch(/AND i\.i18n_key NOT IN \(\?\)/)
  expect(params).toEqual([9, 5, ['users', 'establishment']])
  expect(ADMIN_PROFILE_INTERFACE_KEYS).toEqual(['users', 'establishment'])
})
