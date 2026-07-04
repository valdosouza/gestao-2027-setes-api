import { isModuleEnabled } from '../feature-flags/flag.service'

// Mock do repositório para não depender do banco nos testes unitários
jest.mock('../feature-flags/flag.repository', () => ({
  getFlagsForInstitution: jest.fn(async (institutionId: number) => {
    if (institutionId === 2) {
      return [
        { institutionId: 2, moduleKey: 'core', enabled: true },
        { institutionId: 2, moduleKey: 'erp',  enabled: true },
      ]
    }
    return [
      { institutionId: 3, moduleKey: 'core', enabled: true },
      { institutionId: 3, moduleKey: 'erp',  enabled: false },
    ]
  }),
}))

describe('flag.service', () => {
  it('institution da Setes (id 1) tem acesso a qualquer módulo', async () => {
    const result = await isModuleEnabled(1, 'erp')
    expect(result).toBe(true)
  })

  it('institution com erp habilitado retorna true', async () => {
    const result = await isModuleEnabled(2, 'erp')
    expect(result).toBe(true)
  })

  it('institution sem erp habilitado retorna false', async () => {
    const result = await isModuleEnabled(3, 'erp')
    expect(result).toBe(false)
  })

  it('módulo core está habilitado para ambas', async () => {
    expect(await isModuleEnabled(2, 'core')).toBe(true)
    expect(await isModuleEnabled(3, 'core')).toBe(true)
  })
})
