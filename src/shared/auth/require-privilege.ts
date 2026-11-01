import { Request, Response, NextFunction } from 'express'
import pool from '@shared/db/connection'
import { isSuper } from '@shared/auth/roles'
import { InstitutionPayload } from '@shared/types/express'
import { ErrorCodes } from '@shared/errors/error-codes'
import { accessVerdict, reachableKeys } from '@shared/access'

/**
 * Guardas de privilégio de AÇÃO e de LICENÇA nas rotas — ADAPTADOR Express do veredito único (costura A1 da frente auth-api, D-AU3/D-AU6/
 * D-AU8, Valdo 2026-10-31 — `Infra-IA/prompts/prompt_frente_auth_api.md`). A REGRA saiu daqui: é a biblioteca `fiscal-api/access`, lida
 * por `@shared/access` (a pilha de views `vw_user_link` → `vw_user_reach` → `vw_user_access`), a MESMA da nfse-api e do menu. Aqui fica só
 * a borda HTTP: o envelope do 403 e a resolução da interface por requisição.
 *
 * O que a regra diz (para quem lê a rota — a fonte é o SQL das views, sql/70 + migration 075):
 *  - LICENÇA antes do privilégio (D-F14/D-F37): a interface tem de estar CONTRATADA para admin e regular (403 INTERFACE_NOT_ALLOWED);
 *    o SUPER passa a licença e o privilégio (A-PV1/D-PV24); a tela do Super DELEGÁVEL (D-PV11) só existe para o usuário da Setes, e só
 *    com o verbo marcado pelo Super — até para o admin (D-PV11 (b));
 *  - o admin exerce todo verbo REGISTRADO da interface contratada (D32); o regular, só o concedido (`tb_user_has_privilege`) sobre par
 *    REGISTRADO (D-PV50 item 4) — 403 PRIVILEGE_REQUIRED;
 *  - lista de interfaces (Q-G16): vale o verbo em QUALQUER delas.
 * O perfil é o VIVO (o middleware de autenticação troca o `role` do token pelo da sessão — D-UC9/D-AU3); SEM cache (D-AU8: a revogação
 * vale na hora em todos os processos). Revê a D-PV29 (o cache do veredito por processo MORREU — some `PRIVILEGE_VERDICT_CACHE_TTL_MS`).
 */

/** Veredito de UMA ação: licença (A-PV1/D-F37) antes do privilégio; com lista, vale QUALQUER interface licenciada (Q-G16). */
export type PrivilegeVerdict = 'ok' | 'not-contracted' | 'no-privilege'

/** id de uma interface VIVA pela chave (registro — não é veredito; sem cache: o registro muda pela tela do Super). */
export async function resolveInterfaceId(interfaceKey: string): Promise<number | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_interface WHERE i18n_key = ? AND deleted = 'N' LIMIT 1`,
    [interfaceKey]
  )
  return rows[0] ? Number(rows[0].id) : null
}

/** Chave (i18n_key) de uma interface VIVA pelo id — o inverso de `resolveInterfaceId`. */
export async function resolveInterfaceKey(interfaceId: number): Promise<string | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT i18n_key AS k FROM setes_central.tb_interface WHERE id = ? AND deleted = 'N' LIMIT 1`,
    [interfaceId]
  )
  return rows[0] && rows[0].k != null ? String(rows[0].k) : null
}

/**
 * D-PV24 / A-PV1 — quem escapa da LICENÇA nas conferências que não leem o veredito (a elegibilidade da tela Módulos): só o super
 * legítimo, pelo perfil VIVO. Uma regra só — a mesma que a `vw_user_link` aplica ('super' só na Setes).
 */
export function escapesLicense(inst: InstitutionPayload): boolean {
  return isSuper(inst)
}

/**
 * "Interface ADQUIRIDA" pelo id — a conferência dos painéis de campos/configs (gravar config/campo da tela X exige X ao alcance): o
 * ALCANCE da view (D-PV24: o super escapa; D-PV39: a tela do Super DELEGÁVEL conta para o usuário da Setes; senão, o contrato).
 */
export async function interfaceAcquiredFor(inst: InstitutionPayload, interfaceId: number): Promise<boolean> {
  const key = await resolveInterfaceKey(interfaceId)
  if (key === null) return false                   // fora do catálogo (ou excluída): nega para todos — integridade
  return (await reachableKeys(inst, [key])).length > 0
}

/** O veredito pela biblioteca única (verbo citado pelo id do catálogo; a leitura é pelo NOME — `@shared/access`). */
export async function privilegeVerdict(
  inst: InstitutionPayload, keys: readonly string[], privilegeId: number
): Promise<PrivilegeVerdict> {
  return accessVerdict(inst, keys, privilegeId)
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
 * `interfaceKey` pode ser uma lista: a ação vale pelo privilégio em QUALQUER das interfaces (Q-G16 do cancelamento, Valdo 2026-09-09:
 * a nota da OS cancela pelo mesmo POST /billing/cancel, mas o operador de OS tem a interface `service-orders`, não `orders`).
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
      const verdict = await privilegeVerdict(inst, keys, privilegeId)
      if (verdict !== 'ok') { denyPrivilege(res, verdict, keys); return }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Q-G22 (Valdo 2026-09-09): privilégio na interface do RAMO — a interface é RESOLVIDA por requisição (ex.: `POST /billing/cancel` →
 * pedido com ciclo de OS exige CANCELAR em `service-orders`, senão em `orders`). Quem tem o privilégio só numa interface não cancela
 * documento da outra.
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
 * Q-N32 (Valdo 2026-09-28): LEITURAS fiscais (visão "No fisco", XML, DANFSe) passam pelo ACESSO À INTERFACE do ramo, sem privilégio:
 * a interface resolvida por requisição tem de estar ao ALCANCE de quem pede (contrato; o super passa — A-PV1).
 */
export function requireInterfaceFor(resolveInterface: (req: Request) => Promise<string>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const inst = req.institution
    if (!inst) {
      res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED', fields: [] })
      return
    }
    try {
      const key = await resolveInterface(req)
      if ((await reachableKeys(inst, [key])).length === 0) { interfaceNotAllowed(res, [key]); return }
      next()
    } catch (err) {
      next(err)
    }
  }
}
