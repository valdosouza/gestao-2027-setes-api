import { isModuleEnabled } from '../feature-flags/flag.service'

// Mock do repositório para não depender do banco nos testes unitários
jest.mock('../feature-flags/flag.repository', () => ({
  getFlagsForTenant: jest.fn(async (tenantId: string) => {
    if (tenantId === 'tenant-com-erp') {
      return [
        { tenantId: 'tenant-com-erp', moduleKey: 'core', enabled: true },
        { tenantId: 'tenant-com-erp', moduleKey: 'erp',  enabled: true },
      ]
    }
    return [
      { tenantId: 'tenant-sem-erp', moduleKey: 'core', enabled: true },
      { tenantId: 'tenant-sem-erp', moduleKey: 'erp',  enabled: false },
    ]
  }),
}))

describe('flag.service', () => {
  it('setes admin tem acesso a qualquer módulo', async () => {
    const result = await isModuleEnabled('setes', 'erp')
    expect(result).toBe(true)
  })

  it('tenant com erp habilitado retorna true', async () => {
    const result = await isModuleEnabled('tenant-com-erp', 'erp')
    expect(result).toBe(true)
  })

  it('tenant sem erp habilitado retorna false', async () => {
    const result = await isModuleEnabled('tenant-sem-erp', 'erp')
    expect(result).toBe(false)
  })

  it('módulo core está habilitado para ambos', async () => {
    expect(await isModuleEnabled('tenant-com-erp', 'core')).toBe(true)
    expect(await isModuleEnabled('tenant-sem-erp', 'core')).toBe(true)
  })
})
