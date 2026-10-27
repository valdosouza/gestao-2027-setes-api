import { Request, Response, NextFunction } from 'express'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { isAdmin, isSuper, isOwnVendorInstitution } from '@shared/auth/roles'
import { isDelegableSuperInterface } from '@shared/auth/delegable-interfaces'
import { isInterfaceAcquired } from '@shared/interface-vitrine'
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
 *
 * D-PV24 (Valdo 2026-10-20, divergiu da recomendação): o super escapa TAMBÉM das conferências de licença que NÃO são guarda
 * — o "adquirida" do painel de campos/configs e a elegibilidade do menu da tela Módulos. UMA regra, UM lugar: `escapesLicense`
 * é o predicado que `licensedFor` já usava; `interfaceAcquiredFor` o reaproveita (e carrega a D-PV39: a tela do Super
 * DELEGÁVEL conta como adquirida pela Setes). Consequência registrada: config gravada pelo Super em tela não contratada
 * fica LATENTE e passa a valer no dia em que a tela for contratada (nota em `@shared/interface-config`).
 *
 * D-PV29 (Valdo 2026-10-20, divergiu da recomendação): cache EM MEMÓRIA do VEREDITO (licença + privilégio) por
 * (institution, schema, usuário, interface, privilégio) com TTL curto no molde do `flag.service` (60 s; env
 * `PRIVILEGE_VERDICT_CACHE_TTL_MS`, 0 desliga — os testes rodam desligado, salvo o teste do próprio cache), INVALIDADO ao
 * salvar privilégio (`tb_user_has_privilege`), contrato (`tb_institution_has_interface`) ou vínculo de usuário no mesmo
 * processo (`invalidatePrivilegeVerdicts`) — revogação imediata enquanto houver UM processo. Sem cache para o SUPER (ele
 * não consulta). Limite conhecido para a Onda 4 (vários processos Node): revogação feita num processo vale nos outros só
 * na expiração do TTL — por isso o TTL é curto. A institution já entra na chave (a D-GE3 só troca o que o veredito LÊ).
 *
 * Conhecimento negativo: o id por i18n_key (e a chave por id) ficam no cache do PROCESSO sem expirar — interface
 * soft-deletada no catálogo segue "existindo" para o super até o próximo restart (o catálogo é estável; admin/regular
 * seguem barrados pelo contrato).
 */
const interfaceIdCache = new Map<string, number>()
const interfaceKeyCache = new Map<number, string>()

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

/** Chave (i18n_key) de uma interface VIVA pelo id — o inverso de `resolveInterfaceId`, mesmo cache de processo. */
export async function resolveInterfaceKey(interfaceId: number): Promise<string | null> {
  const cached = interfaceKeyCache.get(interfaceId)
  if (cached !== undefined) return cached
  const [rows] = await pool.query<any[]>(
    `SELECT i18n_key AS k FROM setes_central.tb_interface WHERE id = ? AND deleted = 'N' LIMIT 1`,
    [interfaceId]
  )
  if (!rows[0] || rows[0].k == null) return null
  const key = String(rows[0].k)
  interfaceKeyCache.set(interfaceId, key)
  return key
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
 * D-PV24 / A-PV1 — quem escapa da LICENÇA (contrato) em TODAS as conferências, guarda ou não: só o super legítimo.
 * Admin e regular são barrados pela licença (D-F37). Uma regra, um lugar.
 */
export function escapesLicense(inst: InstitutionPayload): boolean {
  return isSuper(inst)
}

/**
 * A-PV1: a interface vale para QUEM PEDE? Super → basta existir no catálogo central; admin e regular → CONTRATADA
 * (`tb_institution_has_interface` ativa — D-F14/D-F37).
 */
export async function licensedFor(inst: InstitutionPayload, interfaceKey: string): Promise<boolean> {
  if (escapesLicense(inst)) return (await resolveInterfaceId(interfaceKey)) != null
  return institutionHasInterface(inst.schemaName, inst.institutionId, interfaceKey)
}

/**
 * "Interface ADQUIRIDA" pelo id — a conferência dos painéis de campos/configs (gravar config/campo de tela X exige X no
 * contrato): D-PV24 o super escapa; D-PV39 a tela do Super DELEGÁVEL conta como adquirida pela Setes (o override `page_size`
 * do liberado e o valor 'I' por quem tiver CONFIGURAR nela); senão, o contrato (`isInterfaceAcquired`).
 */
export async function interfaceAcquiredFor(inst: InstitutionPayload, interfaceId: number): Promise<boolean> {
  if (escapesLicense(inst)) return true
  if (isOwnVendorInstitution(inst.institutionId) && isDelegableSuperInterface(await resolveInterfaceKey(interfaceId))) return true
  return isInterfaceAcquired(inst.schemaName, inst.institutionId, interfaceId)
}

/** Veredito de UMA ação: licença (A-PV1/D-F37) antes do privilégio; com lista, vale QUALQUER interface licenciada (Q-G16). */
export type PrivilegeVerdict = 'ok' | 'not-contracted' | 'no-privilege'

// ---------------------------------------------------------------------------------------------------------------------
// D-PV29 — cache do veredito por (institution, schema, usuário, interface, privilégio)
// ---------------------------------------------------------------------------------------------------------------------
interface VerdictEntry { expires: number; verdict: PrivilegeVerdict }
const verdictCache = new Map<string, VerdictEntry>()
/** Teto do cache (usuários × interfaces × verbos de um processo) — acima disso limpa tudo em vez de crescer. */
export const VERDICT_CACHE_MAX = 50_000

/** TTL lido a cada chamada (os testes desligam pelo ambiente e o teste do cache liga de volta). */
export function verdictCacheTtlMs(): number {
  const raw = process.env.PRIVILEGE_VERDICT_CACHE_TTL_MS
  const n = raw === undefined || raw === '' ? 60_000 : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const SEP = '\u0000'
function verdictKey(inst: InstitutionPayload, interfaceKey: string, privilegeId: number): string {
  return [inst.institutionId, inst.schemaName, inst.userId, interfaceKey, privilegeId].join(SEP)
}

/** Veredito de UMA interface para admin/regular (o super não chega aqui): licença → privilégio. Cacheado. */
async function keyVerdict(inst: InstitutionPayload, interfaceKey: string, privilegeId: number): Promise<PrivilegeVerdict> {
  const ttl = verdictCacheTtlMs()
  const k = verdictKey(inst, interfaceKey, privilegeId)
  if (ttl > 0) {
    const hit = verdictCache.get(k)
    if (hit && hit.expires > Date.now()) return hit.verdict
  }
  let verdict: PrivilegeVerdict
  if (!(await institutionHasInterface(inst.schemaName, inst.institutionId, interfaceKey))) verdict = 'not-contracted'
  else if (isAdmin(inst) || await userHasPrivilege(inst.schemaName, inst.userId, interfaceKey, privilegeId)) verdict = 'ok'
  else verdict = 'no-privilege'
  if (ttl > 0) {
    if (verdictCache.size >= VERDICT_CACHE_MAX) verdictCache.clear()     // teto de segurança: expirados não são varridos
    verdictCache.set(k, { expires: Date.now() + ttl, verdict })
  }
  return verdict
}

export interface VerdictInvalidationScope {
  institutionId?: number
  userId?: number
  schemaName?: string
}

/**
 * D-PV29: derruba os vereditos guardados — ao salvar privilégio (por usuário), contrato (por institution) ou vínculo de
 * usuário (por usuário). Sem escopo = tudo. Só vale no PROCESSO corrente (limite conhecido da Onda 4 — o TTL cobre o resto).
 */
export function invalidatePrivilegeVerdicts(scope: VerdictInvalidationScope = {}): void {
  for (const k of verdictCache.keys()) {
    const [institutionId, schemaName, userId] = k.split(SEP)
    if (scope.institutionId !== undefined && Number(institutionId) !== scope.institutionId) continue
    if (scope.schemaName !== undefined && schemaName !== scope.schemaName) continue
    if (scope.userId !== undefined && Number(userId) !== scope.userId) continue
    verdictCache.delete(k)
  }
}

/** Testes do cache: quantas entradas vivas. */
export function privilegeVerdictCacheSize(): number {
  return verdictCache.size
}

export async function privilegeVerdict(
  inst: InstitutionPayload, keys: readonly string[], privilegeId: number
): Promise<PrivilegeVerdict> {
  if (escapesLicense(inst)) {
    // A-PV1: o super passa licença e privilégio — a interface só precisa EXISTIR no catálogo (integridade). Nunca cacheado.
    for (const key of keys) if ((await resolveInterfaceId(key)) != null) return 'ok'
    return 'not-contracted'
  }
  let contracted = false
  for (const key of keys) {
    const verdict = await keyVerdict(inst, key, privilegeId)
    if (verdict === 'ok') return 'ok'
    if (verdict === 'no-privilege') contracted = true
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

/** Testes / catálogo alterado em runtime: derruba os ids por chave, as chaves por id e os vereditos (D-PV29). */
export function resetPrivilegeCache(): void {
  interfaceIdCache.clear()
  interfaceKeyCache.clear()
  verdictCache.clear()
}
