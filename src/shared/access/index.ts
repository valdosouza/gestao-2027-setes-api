import pool from '@shared/db/connection'
import * as lib from 'fiscal-api/access'
import { InstitutionPayload } from '@shared/types/express'
import { HttpError } from '@shared/errors/http-error'
import { assertSchema } from '@shared/db/schema'
import {
  PRIVILEGE_INSERIR, PRIVILEGE_ALTERAR, PRIVILEGE_EXCLUIR, PRIVILEGE_IMPRIMIR, PRIVILEGE_FATURAR, PRIVILEGE_VISUALIZAR,
  PRIVILEGE_CANCELAR, PRIVILEGE_DESCONTO, PRIVILEGE_TRANSMITIR, PRIVILEGE_CATALOGAR, PRIVILEGE_CONFIGURAR, PRIVILEGE_CONSULTAR,
} from '@shared/auth/privileges'

/**
 * `@shared/access` — o ADAPTADOR do setes-api para o veredito de acesso (costura A1 da frente auth-api — D-AU3/D-AU6/D-AU8, Valdo
 * 2026-10-31; `Infra-IA/prompts/prompt_frente_auth_api.md`). A REGRA não mora aqui: é a biblioteca ÚNICA `fiscal-api/access` (a pilha de
 * views `vw_user_link` → `vw_user_reach` → `vw_user_access`, publicada no banco — sql/70 + migration 075), a MESMA que a nfse-api lê.
 * Aqui só: o pool do setes-api, a identidade do token e a tradução id → NOME do verbo.
 *
 * Até a A2 o setes-api é quem ESCREVE o registro (`tb_privilege`, `tb_interface_has_privilege`) — por isso as rotas ainda citam o verbo
 * pela constante numérica de `@shared/auth/privileges`; a LEITURA do veredito é sempre pelo NOME (D-PV53), e o nome dos verbos consumidos
 * é protegido pela guarda do catálogo (D-PV15 — a tela Privilégios recusa renomear). SEM cache (D-AU8): toda pergunta lê a view viva.
 */

export type { PrivilegeName, AccessVerdict, AccessProfile, AccessRow } from 'fiscal-api/access'
export { PRIVILEGE_NAMES, isPrivilegeName } from 'fiscal-api/access'

/** id do catálogo → NOME do verbo (`tb_privilege.description`). Conferido contra o banco pelo teste ao vivo da cerca. */
export const PRIVILEGE_NAME_BY_ID: Readonly<Record<number, lib.PrivilegeName>> = Object.freeze({
  [PRIVILEGE_INSERIR]:    'INSERIR',
  [PRIVILEGE_ALTERAR]:    'ALTERAR',
  [PRIVILEGE_EXCLUIR]:    'EXCLUIR',
  [PRIVILEGE_IMPRIMIR]:   'IMPRIMIR',
  [PRIVILEGE_FATURAR]:    'FATURAR',
  [PRIVILEGE_VISUALIZAR]: 'VISUALIZAR',
  [PRIVILEGE_CANCELAR]:   'CANCELAR',
  [PRIVILEGE_DESCONTO]:   'DESCONTO',
  [PRIVILEGE_TRANSMITIR]: 'TRANSMITIR',
  [PRIVILEGE_CATALOGAR]:  'CATALOGAR',
  [PRIVILEGE_CONFIGURAR]: 'CONFIGURAR',
  [PRIVILEGE_CONSULTAR]:  'CONSULTAR',
})

/** O nome do verbo de um id — `null` para id fora do vocabulário (quem pergunta NEGA: falha fechada). */
export function privilegeNameOf(privilege: number | lib.PrivilegeName): lib.PrivilegeName | null {
  if (typeof privilege === 'string') return lib.isPrivilegeName(privilege) ? privilege : null
  return PRIVILEGE_NAME_BY_ID[privilege] ?? null
}

/**
 * A SESSÃO viva (D-UC9 + D-AU3): o payload do token com o PERFIL VIVO no `role`, ou `null` quando o vínculo, a credencial ou o
 * estabelecimento não valem mais — ou quando a senha foi definida DEPOIS do `iat` do token (D-EA7). Chamada pelo middleware de autenticação
 * em TODA rota protegida e pela troca do token de SELEÇÃO pelo final (o token de seleção anterior à troca de senha também não cunha).
 */
export async function liveSession(payload: InstitutionPayload, iat: number): Promise<InstitutionPayload | null> {
  let session: Awaited<ReturnType<typeof lib.sessionOf>>
  try {
    session = await lib.sessionOf(pool, payload, iat)
  } catch (err) {
    // o erro HTTP da biblioteca (ex.: 503 SESSION_UNAVAILABLE — banco fora; o classificador é UM só, lá) vira o HttpError DESTE projeto:
    // são classes diferentes, e o middleware e o `fail()` do auth reconhecem o daqui (sem isso o 503 virava 401 e derrubava o login)
    const e = err as { statusCode?: unknown; message?: unknown; code?: unknown } | null
    if (e && typeof e.statusCode === 'number') {
      throw new HttpError(e.statusCode, String(e.message ?? ''), undefined, typeof e.code === 'string' ? e.code : undefined)
    }
    throw err
  }
  return session ? { ...payload, role: session.profile } : null
}

/** A forma CANÔNICA da chave de interface (D-PV42) — a da biblioteca, a única cópia (o catálogo a usa como `INTERFACE_KEY_PATTERN`). */
export const INTERFACE_KEY_FORM: RegExp = lib.INTERFACE_KEY_FORM

/** O veredito de UMA ação (o verbo em QUALQUER das interfaces — Q-G16). */
export async function accessVerdict(
  inst: InstitutionPayload, keys: readonly string[], privilege: number | lib.PrivilegeName,
): Promise<lib.AccessVerdict> {
  const name = privilegeNameOf(privilege)
  if (name === null) return 'no-privilege'                 // verbo que não existe: ninguém o tem (o MESMO motivo da biblioteca)
  return lib.accessVerdict(pool, inst, keys, name)
}

/** Das interfaces, as AO ALCANCE de quem pede (licença; o super todas; a delegável só para o usuário da Setes). */
export async function reachableKeys(inst: InstitutionPayload, keys: readonly string[]): Promise<string[]> {
  return lib.reachableKeys(pool, inst, keys)
}

/** Tudo o que o usuário pode no estabelecimento (o menu). */
export async function accessRows(inst: InstitutionPayload): Promise<lib.AccessRow[]> {
  return lib.accessRows(pool, inst)
}

/**
 * Boot (costura A1): as views CENTRAIS do veredito (script sql/70) existem com as colunas que a biblioteca lê, e os dois LITERAIS que elas
 * carregam batem com as constantes do código — `1` = SETES_INSTITUTION_ID (D-PV37: ninguém além da Setes é "vendor") e a lista das telas
 * do Super delegáveis (D-PV11 (d)). Faltando a view, ou literal divergente, o setes-api NÃO sobe: o veredito estaria errado em TODA rota.
 * As views POR SCHEMA (`vw_user_reach`/`vw_user_access`) nascem da migration 075, que roda no mesmo boot.
 */
export async function assertAccessViews(
  vendorInstitutionId: number, delegableKeys: readonly string[],
): Promise<string> {
  const views: [string, string][] = [
    ['vw_user_link', 'tb_user_id, tb_institution_id, schema_name, profile, vendor, password_set_at'],
    ['vw_interface_catalog', 'tb_interface_id, interface_key, delegable'],
  ]
  for (const [view, columns] of views) {
    try {
      await pool.query(`SELECT ${columns} FROM setes_central.${view} LIMIT 0`)
    } catch (err: any) {
      if (err?.errno === 1146 || err?.code === 'ER_NO_SUCH_TABLE' || err?.errno === 1054 || err?.code === 'ER_BAD_FIELD_ERROR') {
        throw new Error(`setes_central.${view} ausente ou incompleta — aplique o script sql/70_user_access_central_views.sql em `
          + 'setes_central ANTES do setes-api (costura A1 — D-AU3)')
      }
      throw err
    }
  }
  const [vendors] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n FROM setes_central.vw_user_link WHERE vendor = 'S' AND tb_institution_id <> ?`, [vendorInstitutionId])
  const [own] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n FROM setes_central.vw_user_link WHERE vendor <> 'S' AND tb_institution_id = ?`, [vendorInstitutionId])
  if (Number(vendors[0]?.n ?? 0) > 0 || Number(own[0]?.n ?? 0) > 0) {
    throw new Error(`setes_central.vw_user_link marca como "a Setes" outra institution que não a ${vendorInstitutionId} — o literal da `
      + 'view divergiu de SETES_INSTITUTION_ID (D-PV37); corrija o sql/70 e reaplique')
  }
  const [delegable] = await pool.query<any[]>(
    `SELECT interface_key AS k FROM setes_central.vw_interface_catalog WHERE delegable = 'S'`)
  const [present] = await pool.query<any[]>(
    `SELECT i18n_key AS k FROM setes_central.tb_interface WHERE deleted = 'N' AND i18n_key IN (?)`,
    [delegableKeys.length ? [...delegableKeys] : ['']])
  const got = delegable.map(r => String(r.k)).sort()
  const want = present.map(r => String(r.k)).sort()
  if (got.join('|') !== want.join('|')) {
    throw new Error(`setes_central.vw_interface_catalog marca como delegáveis [${got.join(', ')}] e o código diz [${want.join(', ')}] — `
      + 'o literal da view divergiu de DELEGABLE_SUPER_INTERFACES (D-PV11 (d)); corrija o sql/70 e reaplique')
  }
  return 'ok'
}

/**
 * Boot, DEPOIS das migrations (gate socrático da costura A1): as views POR SCHEMA do veredito (migration 075) em CADA institution ativa,
 * pelas colunas que a biblioteca lê. Faltando num schema, o setes-api NÃO sobe — sem elas toda guarda daquele cliente viraria 500 na 1ª
 * leitura (o molde da conferência dos gatilhos da F2a). As centrais (sql/70) são conferidas antes, por `assertAccessViews`.
 */
export async function assertAccessSchemaViews(): Promise<string> {
  const [institutions] = await pool.query<any[]>(
    "SELECT schema_name FROM setes_central.tb_institution WHERE active = 'S' AND deleted = 'N'")
  const bad: string[] = []
  for (const i of institutions) {
    const schema = assertSchema(String(i.schema_name))      // o nome vai interpolado: a MESMA guarda dos outros leitores
    for (const [view, columns] of SCHEMA_VIEW_COLUMNS) {
      try {
        await pool.query(`SELECT ${columns} FROM \`${schema}\`.${view} LIMIT 0`)
      } catch (err: any) {
        if (err?.errno === 1146 || err?.code === 'ER_NO_SUCH_TABLE' || err?.errno === 1054 || err?.code === 'ER_BAD_FIELD_ERROR'
          || err?.errno === 1356 || err?.code === 'ER_VIEW_INVALID') {
          bad.push(`${schema}.${view}`)
          continue
        }
        throw err
      }
    }
  }
  if (bad.length) {
    throw new Error(`views do veredito de acesso ausentes ou inválidas: ${bad.join(', ')} — a migration 075 não rodou nesses schemas `
      + '(ou o script sql/70 foi aplicado depois e a view ficou inválida: reaplique a 075 no schema) — costura A1 (D-AU3)')
  }
  return `${institutions.length} schema(s)`
}

/** As colunas que a biblioteca `fiscal-api/access` lê de cada view por schema (a 075). */
const SCHEMA_VIEW_COLUMNS: readonly [string, string][] = [
  ['vw_user_reach', 'tb_user_id, tb_institution_id, tb_interface_id, interface_key, profile, delegable'],
  ['vw_user_access', 'tb_user_id, tb_institution_id, tb_interface_id, interface_key, tb_privilege_id, privilege, profile, delegable'],
]
