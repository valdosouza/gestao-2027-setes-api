/**
 * Dublê do VEREDITO de acesso para os testes de rota/guarda (costura A1 da auth-api — D-AU3/D-AU6, 2026-10-31). Responde às leituras que a
 * biblioteca `fiscal-api/access` faz nas views (`vw_user_link`, `vw_user_reach`, `vw_user_access`) a partir de um MODELO pequeno — perfil,
 * contrato, pares registrados, concessões. A regra aqui ESPELHA o SQL das views (sql/70 + migration 075) para o teste montar o cenário; a
 * semântica REAL das views é provada ao vivo em banco descartável (`scripts/prove-user-access-views.ts`).
 *
 * Uso: dentro do dublê do `pool.query` do teste —
 *   const a = accessAnswer(sql, params, modelFor)   // modelFor(userId, institutionId) → AccessModel | null
 *   if (a) return [a, []]
 */
export type ModelProfile = 'super' | 'admin' | 'user'

export interface AccessModel {
  profile: ModelProfile
  /** vínculo com a própria Setes (institution 1) — decide a tela delegável. */
  vendor?: boolean
  /** chaves com a licença viva (`tb_institution_has_interface`). */
  contracted?: readonly string[]
  /** pares REGISTRADOS por chave; ausente = todo verbo registrado em toda chave. */
  registered?: Readonly<Record<string, readonly string[]>>
  /** concessões (`tb_user_has_privilege`) por chave. */
  granted?: Readonly<Record<string, readonly string[]>>
  /** telas do Super delegáveis (padrão: 'institution-interfaces'). */
  delegable?: readonly string[]
  /** id de cada chave (para o menu); padrão: posição na lista + 100. */
  interfaceIds?: Readonly<Record<string, number>>
}

export const ALL_VERBS = [
  'INSERIR', 'ALTERAR', 'EXCLUIR', 'IMPRIMIR', 'FATURAR', 'VISUALIZAR', 'CANCELAR', 'DESCONTO', 'TRANSMITIR', 'CATALOGAR', 'CONFIGURAR',
  'CONSULTAR',
] as const

const delegableOf = (m: AccessModel) => m.delegable ?? ['institution-interfaces']

export function modelReaches(m: AccessModel, key: string): boolean {
  if (m.profile === 'super') return true
  if (delegableOf(m).includes(key)) return !!m.vendor
  return (m.contracted ?? []).includes(key)
}

export function modelRegistered(m: AccessModel, key: string, verb: string): boolean {
  if (!m.registered) return true
  return (m.registered[key] ?? []).includes(verb)
}

export function modelAllows(m: AccessModel, key: string, verb: string): boolean {
  if (!modelReaches(m, key) || !modelRegistered(m, key, verb)) return false
  if (m.profile === 'super') return true
  if (m.profile === 'admin' && !delegableOf(m).includes(key)) return true
  return (m.granted?.[key] ?? []).includes(verb)
}

type ModelSource = AccessModel | ((userId: number, institutionId: number) => AccessModel | null)

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()

/** Linhas da resposta, ou `undefined` quando o SQL não é uma leitura das views do veredito. */
export function accessAnswer(sql: string, params: any[], source: ModelSource, keys?: readonly string[]): any[] | undefined {
  const t = norm(sql)
  const model = (u: number, i: number) => (typeof source === 'function' ? source(u, i) : source)
  if (/FROM setes_central\.vw_user_link WHERE tb_user_id = \? AND tb_institution_id = \? AND schema_name = \?/.test(t)) {
    const m = model(Number(params[0]), Number(params[1]))
    return m ? [{ profile: m.profile, vendor: m.vendor ? 'S' : 'N' }] : []
  }
  const m = /FROM `[a-z0-9_]+`\.vw_user_(access|reach) WHERE tb_user_id = \? AND tb_institution_id = \?( AND interface_key IN \(\?\))?( AND privilege = \?)?/.exec(t)
  if (!m) return undefined
  const mm = model(Number(params[0]), Number(params[1]))
  if (!mm) return []
  if (m[1] === 'reach') {
    const wanted: string[] = params[2] ?? []
    return wanted.filter(k => modelReaches(mm, k)).map(k => ({ k }))
  }
  if (m[2] && m[3]) {                                         // veredito (LIMIT 1) ou grantedKeys
    const wanted: string[] = params[2] ?? []
    const verb = String(params[3])
    const ok = wanted.filter(k => modelAllows(mm, k, verb))
    return /LIMIT 1$/.test(t) ? (ok.length ? [{ 1: 1 }] : []) : ok.map(k => ({ k }))
  }
  // accessRows (o menu): toda chave conhecida do modelo × todo verbo
  const universe = new Set<string>([
    ...(keys ?? []), ...(mm.contracted ?? []), ...Object.keys(mm.registered ?? {}), ...Object.keys(mm.granted ?? {}),
    ...Object.keys(mm.interfaceIds ?? {}),
  ])
  const ids = mm.interfaceIds ?? {}
  const out: any[] = []
  let n = 100
  for (const k of universe) {
    const id = ids[k] ?? n++
    for (const verb of ALL_VERBS) if (modelAllows(mm, k, verb)) out.push({ interfaceId: id, interfaceKey: k, privilege: verb })
  }
  return out
}
