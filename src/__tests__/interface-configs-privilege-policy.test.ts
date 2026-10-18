/// <reference types="jest" />
// A-PV8 (2026-10-18 — prompt_privilegios_interfaces.md §11): o privilégio da "Configurações Gerais" só abre o painel de configs
// QUANDO o painel é o dela. O resolvedor lê o `:id` com a MESMA regra do controller (`parseId` = Number inteiro) — se lessem
// diferente, o privilégio de uma interface abriria o painel de outra.
import pool from '../shared/db/connection'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { CONFIGS_PANEL } from '../modules/interface-configs/interface-configs.privilege-policy'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock

beforeEach(() => {
  jest.clearAllMocks(); resetPrivilegeCache()
  mockQuery.mockImplementation(async (_sql: string, params: any[]) => [params[0] === 'general-configs' ? [{ id: 11 }] : []])
})

const BOTH = ['interface-configs', 'general-configs']
const PANEL = ['interface-configs']

it.each([
  ['11', BOTH], ['011', BOTH], ['11.0', BOTH], ['1.1e1', BOTH],          // Number(...) === 11 — o controller também lê 11
  ['12', PANEL], ['1', PANEL], ['11abc', PANEL], ['11.5', PANEL], ['-11', PANEL], ['', PANEL], ['0x11', PANEL],
])('`:id` = %p → %p', async (raw, expected) => {
  expect(await CONFIGS_PANEL.resolve({ id: raw })).toEqual(expected)
  // a mesma leitura do controller: quando o resolvedor diz "é o painel 11", o parseId do controller também lê 11
  const n = Number(raw)
  if (expected === BOTH) expect(Number.isInteger(n) && n >= 0 && n === 11).toBe(true)
})

it('sem a interface general-configs no catálogo, nenhum painel aceita o privilégio dela', async () => {
  mockQuery.mockImplementation(async () => [[]])
  expect(await CONFIGS_PANEL.resolve({ id: '11' })).toEqual(PANEL)
})
