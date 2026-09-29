import { Request, Response, NextFunction } from 'express'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { isAdmin } from '@shared/auth/roles'

/**
 * Guard de privilégio de AÇÃO na rota (D12 + Q-P5 do cancelamento de nota,
 * Valdo 2026-09-08). Até aqui a API só tinha superGuard/adminGuard, e os
 * privilégios do catálogo (INSERIR…FATURAR) ligavam/desligavam BOTÕES no
 * app (decisão 21 da Fase 1) — a regra vivia só na tela.
 *
 * Regra: super e admin passam (core.service: admin tem TUDO do contrato da
 * institution, sem tb_user_has_privilege); usuário regular precisa do
 * vínculo ATIVO em tb_user_has_privilege (schema do cliente) para a
 * interface (i18n_key do catálogo central) × privilégio. O id da interface
 * é cacheado por i18n_key (catálogo estável).
 */
const interfaceIdCache = new Map<string, number>()

async function resolveInterfaceId(interfaceKey: string): Promise<number | null> {
  const cached = interfaceIdCache.get(interfaceKey)
  if (cached !== undefined) return cached
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_interface WHERE i18n_key = ? AND deleted = 'N' LIMIT 1`,
    [interfaceKey]
  )
  if (!rows[0]) return null
  const id = Number(rows[0].id)
  interfaceIdCache.set(interfaceKey, id)
  return id
}

/** Usuário regular tem o privilégio na interface? (vínculo ativo, não deletado) */
export async function userHasPrivilege(
  schemaName: string, userId: number, interfaceKey: string, privilegeId: number
): Promise<boolean> {
  const s = assertSchema(schemaName)
  const interfaceId = await resolveInterfaceId(interfaceKey)
  if (interfaceId == null) return false
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM \`${s}\`.tb_user_has_privilege
      WHERE tb_user_id = ? AND tb_interface_id = ? AND tb_privilege_id = ?
        AND active = 'S' AND deleted = 'N' LIMIT 1`,
    [userId, interfaceId, privilegeId]
  )
  return rows.length > 0
}

/**
 * `interfaceKey` pode ser uma lista: a ação vale pelo privilégio em QUALQUER
 * das interfaces (Q-G16 do cancelamento, Valdo 2026-09-09: a nota da OS
 * cancela pelo mesmo POST /billing/cancel, mas o operador de OS tem a
 * interface `service-orders`, não `orders` — privilégio na interface do RAMO).
 */
export function requirePrivilege(interfaceKey: string | string[], privilegeId: number) {
  const keys = Array.isArray(interfaceKey) ? interfaceKey : [interfaceKey]
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const inst = req.institution
    if (!inst) {
      res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED', fields: [] })
      return
    }
    if (isAdmin(inst)) { next(); return }
    try {
      let ok = false
      for (const key of keys) {
        if (await userHasPrivilege(inst.schemaName, inst.userId, key, privilegeId)) { ok = true; break }
      }
      if (!ok) {
        res.status(403).json({
          error: 'Privilégio necessário para esta ação', code: 'PRIVILEGE_REQUIRED', fields: [],
        })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Q-G22 (Valdo 2026-09-09): privilégio na interface do RAMO — a interface
 * é RESOLVIDA por requisição (ex.: `POST /billing/cancel` → pedido com ciclo
 * de OS exige CANCELAR em `service-orders`, senão em `orders`). Quem tem o
 * privilégio só numa interface não cancela documento da outra.
 */
export function requirePrivilegeFor(
  privilegeId: number, resolveInterface: (req: Request) => Promise<string>
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const inst = req.institution
    if (!inst) {
      res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED', fields: [] })
      return
    }
    if (isAdmin(inst)) { next(); return }
    try {
      const key = await resolveInterface(req)
      const ok = await userHasPrivilege(inst.schemaName, inst.userId, key, privilegeId)
      if (!ok) {
        res.status(403).json({
          error: 'Privilégio necessário para esta ação', code: 'PRIVILEGE_REQUIRED', fields: [],
        })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Q-N32 (Valdo 2026-09-28, "siga as recomendações"): LEITURAS fiscais (visão "No fisco", XML, DANFSe — o
 * XML carrega dados do tomador) passam pelo ACESSO À INTERFACE do ramo, sem privilégio novo: a interface
 * resolvida por requisição tem que estar no contrato da institution (`tb_institution_has_interface`
 * ativa). Admin passa. Não existe acesso por usuário a interface no modelo — o contrato é da institution.
 */
export async function institutionHasInterface(schemaName: string, institutionId: number, interfaceKey: string): Promise<boolean> {
  const s = assertSchema(schemaName)
  const interfaceId = await resolveInterfaceId(interfaceKey)
  if (interfaceId == null) return false
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM \`${s}\`.tb_institution_has_interface
      WHERE tb_institution_id = ? AND tb_interface_id = ? AND (active IS NULL OR active = 'S') AND deleted = 'N' LIMIT 1`,
    [institutionId, interfaceId]
  )
  return rows.length > 0
}

export function requireInterfaceFor(resolveInterface: (req: Request) => Promise<string>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const inst = req.institution
    if (!inst) {
      res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED', fields: [] })
      return
    }
    if (isAdmin(inst)) { next(); return }
    try {
      const key = await resolveInterface(req)
      if (!(await institutionHasInterface(inst.schemaName, inst.institutionId, key))) {
        res.status(403).json({ error: `Interface ${key} não contratada para este estabelecimento`, code: 'INTERFACE_NOT_ALLOWED', fields: [] })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/** Testes / catálogo alterado em runtime. */
export function resetPrivilegeCache(): void {
  interfaceIdCache.clear()
}
