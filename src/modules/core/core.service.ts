import { getInstitutionInfo } from './core.repository'

export async function getInstitutionData(schemaName: string) {
  const institution = await getInstitutionInfo(schemaName)
  if (!institution) throw new Error('Institution não encontrada')
  return institution
}
