import { InstitutionPayload } from '@shared/types/express'

// Institution da Setes — hard coded (Fase 2, decisão 14)
export const SETES_INSTITUTION_ID = 1

// 'super' só é reconhecido no vínculo com a institution da Setes (id 1).
// Em qualquer outra institution, role 'super' é ignorado.
export function isSuper(payload?: InstitutionPayload): boolean {
  return payload?.institutionId === SETES_INSTITUTION_ID && payload?.role === 'super'
}
