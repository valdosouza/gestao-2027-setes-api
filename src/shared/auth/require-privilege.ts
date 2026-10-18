import { Request, Response, NextFunction } from 'express'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { isAdmin, isSuper } from '@shared/auth/roles'
import { InstitutionPayload } from '@shared/types/express'
import { ErrorCodes } from '@shared/errors/error-codes'

/**
 * Guard de privilégio de AÇÃO na rota (D12 + Q-P5 do cancelamento de nota,
 * Valdo 2026-09-08). Até aqui a API só tinha superGuard/adminGuard, e os
 * privilégios do catálogo (INSERIR…FATURAR) ligavam/desligavam BOTÕES no
 * app (decisão 21 da Fase 1) — a regra vivia só na tela.
 *
 * Regra: super e admin passam o PRIVILÉGIO (core.service: admin tem TUDO do
 * contrato da institution, sem tb_user_has_privilege); usuário regular precisa
 * do vínculo ATIVO em tb_user_has_privilege (schema do cliente) para a
 * interface (i18n_key do catálogo central) × privilégio. O id da interface
 * é cacheado por i18n_key (catálogo estável).
 *
 * D-F37 (= Q-F46 (b), Valdo 2026-10-04 — aplicada ao ERP na F2a, etapa A2, prompt_apis_fiscais_isoladas.md
 * §22.9): a LICENÇA vale para TODOS. A interface tem de estar CONTRATADA (`tb_institution_has_interface` ativa)
 * para qualquer perfil — admin e super passam só o PRIVILÉGIO, nunca a interface não contratada (D-F14: licença é
 * o que se vendeu). Mesma regra das guardas da nfse-api (`nfse-api/src/modules/guards.ts`); a licença é conferida
 * ANTES do privilégio (403 INTERFACE_NOT_ALLOWED × 403 PRIVILEGE_REQUIRED). Antes de ligar, o dado foi conferido
 * (2026-10-12): a única institution ativa contrata as 4 interfaces das guardas — ninguém perdeu acesso.
 *
 * A-PV1 (Valdo 2026-10-18 — `Infra-IA/prompts/prompt_privilegios_interfaces.md`, D-PV3: "o super deve escapar de todas
 * as verificações"): o SUPER passa também a LICENÇA — revê a D-F37 SÓ para ele (admin e regular seguem barrados pela
 * licença). A interface tem de EXISTIR no catálogo central — isso é integridade do código, não licença: chave que não
 * existe no catálogo nega para todos. Peça única: `licensedFor`.
 * Conhecimento negativo: o id por i18n_key fica no cache do PROCESSO sem expirar — interface soft-deletada no catálogo
 * segue "existindo" para o super até o próximo restart (o catálogo é estável; admin/regular seguem barrados pelo contrato).
 */
const interfaceIdCache = new Map<string, number>()

export async function resolveInterfaceId(interfaceKey: string): Promise<number | null> {
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
 * A-PV1: a interface vale para QUEM PEDE? Super → basta existir no catálogo central; admin e regular → CONTRATADA
 * (`tb_institution_has_interface` ativa — D-F14/D-F37).
 */
export async function licensedFor(inst: InstitutionPayload, interfaceKey: string): Promise<boolean> {
  if (isSuper(inst)) return (await resolveInterfaceId(interfaceKey)) != null
  return institutionHasInterface(inst.schemaName, inst.institutionId, interfaceKey)
}

/** Veredito de UMA ação: licença (A-PV1/D-F37) antes do privilégio; com lista, vale QUALQUER interface licenciada (Q-G16). */
export type PrivilegeVerdict = 'ok' | 'not-contracted' | 'no-privilege'

export async function privilegeVerdict(
  inst: InstitutionPayload, keys: readonly string[], privilegeId: number
): Promise<PrivilegeVerdict> {
  let contracted = false
  for (const key of keys) {
    if (!(await licensedFor(inst, key))) continue
    contracted = true
    if (isAdmin(inst) || await userHasPrivilege(inst.schemaName, inst.userId, key, privilegeId)) return 'ok'
  }
  return contracted ? 'no-privilege' : 'not-contracted'
}

/** Resposta do veredito negado — o MESMO envelope em toda guarda (403 INTERFACE_NOT_ALLOWED × 403 PRIVILEGE_REQUIRED). */
export function denyPrivilege(res: Response, verdict: Exclude<PrivilegeVerdict, 'ok'>, keys: readonly string[]): void {
  if (verdict === 'not-contracted') { interfaceNotAllowed(res, [...keys]); return }
  res.status(403).json({ error: 'Privilégio necessário para esta ação', code: ErrorCodes.PRIVILEGE_REQUIRED, fields: [] })
}

function interfaceNotAllowed(res: Response, keys: string[]): void {
  res.status(403).json({
    error: `Interface ${keys.join(' / ')} não contratada para este estabelecimento`, code: ErrorCodes.INTERFACE_NOT_ALLOWED, fields: [],
  })
}

/**
 * `interfaceKey` pode ser uma lista: a ação vale pelo privilégio em QUALQUER
 * das interfaces (Q-G16 do cancelamento, Valdo 2026-09-09: a nota da OS
 * cancela pelo mesmo POST /billing/cancel, mas o operador de OS tem a
 * interface `service-orders`, não `orders` — privilégio na interface do RAMO).
 * D-F37: só contam as interfaces CONTRATADAS — nenhuma contratada = 403 INTERFACE_NOT_ALLOWED (A-PV1: menos para o super).
 */
export function requirePrivilege(interfaceKey: string | string[], privilegeId: number) {
  const keys = Array.isArray(interfaceKey) ? interfaceKey : [interfaceKey]
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const inst = req.institution
    if (!inst) {
      res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED', fields: [] })
      return
    }
    try {
      const verdict = await privilegeVerdict(inst, keys, privilegeId)   // D-F37 + A-PV1: licença (o super passa) antes do privilégio
      if (verdict !== 'ok') { denyPrivilege(res, verdict, keys); return }
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
 * D-F37: a interface do ramo tem de estar CONTRATADA (o admin passa só o privilégio; A-PV1: o super passa as duas).
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
    try {
      const key = await resolveInterface(req)
      const verdict = await privilegeVerdict(inst, [key], privilegeId)
      if (verdict !== 'ok') { denyPrivilege(res, verdict, [key]); return }
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
 * ativa). Não existe acesso por usuário a interface no modelo — o contrato é da institution.
 * D-F37 (F2a A2): o admin NÃO passa a licença (antes passava). A-PV1: o super passa (`licensedFor`).
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
    try {
      const key = await resolveInterface(req)
      if (!(await licensedFor(inst, key))) { interfaceNotAllowed(res, [key]); return }   // A-PV1: o super passa a licença
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
