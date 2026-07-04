import { getTenantInfo } from './core.repository'

export async function getTenantData(schemaName: string) {
  const tenant = await getTenantInfo(schemaName)
  if (!tenant) throw new Error('Tenant não encontrado')
  return tenant
}
