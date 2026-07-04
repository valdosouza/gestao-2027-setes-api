import { Request } from 'express'

export interface TenantPayload {
  tenantId: string
  userId: string
  role: 'setes_admin' | 'client_user'
  schemaName: string
}

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantPayload
    }
  }
}
