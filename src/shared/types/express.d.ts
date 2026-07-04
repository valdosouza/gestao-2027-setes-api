import { Request } from 'express'

// Fase 2 (decisão 16): todo tenant é uma institution.
// role = perfil do usuário na institution (tb_institution_has_user.kind);
// 'super' só vale na institution da Setes (id 1) — ver @shared/auth/roles.
export interface InstitutionPayload {
  institutionId: number
  userId: number
  role: string
  schemaName: string
}

declare global {
  namespace Express {
    interface Request {
      institution?: InstitutionPayload
    }
  }
}
