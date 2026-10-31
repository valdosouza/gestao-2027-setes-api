import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { escapeLike, ListQuery, PagedRows } from '@shared/list'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'

/**
 * Vínculo ESTABELECIMENTO × INTERFACES (`tb_institution_has_interface` — o "contrato de interfaces": quais telas cada cliente tem;
 * decisões 17/18/23 da Fase 1). Peça ÚNICA de leitura e escrita desde a D-PV11 (2026-10-18 — prompt_privilegios_interfaces.md):
 * dois consumidores — a aba Interfaces do cadastro de Estabelecimento (Super, `/api/admin`) e a tela "Interfaces dos clientes"
 * (`/api/institution-interfaces`, delegável pelo Super a usuário da Setes). Duas telas, UMA regra de escrita.
 *
 * O contrato da institution ALVO é lido pela chave DELA — nunca o schema inteiro (D-GE4: com 2 institutions no schema, sem o filtro
 * a tela mostraria o contratado da outra e o salvar o copiaria). Hoje 1 institution por schema; na onda 1 do grupo a chave vira a do
 * grupo (D-GE22).
 *
 * Rodada 2026-10-20 (Valdo):
 *  - D-PV34: a gravação é POR MARCA — cada clique concede ou revoga UM id (`setInstitutionInterfaceLink`), idempotente (conceder o já
 *    concedido = nada muda, `changed: false`); nunca a lista inteira. Vale para as DUAS portas. Casa com a trilha da D-PV33 (um
 *    evento por marca, depois da janela).
 *  - D-PV35: a lista das ESTRUTURAIS é UMA constante aqui (`STRUCTURAL_INTERFACE_KEYS`), consumida pelo onboarding
 *    (`grantStructuralInterfaces`) e pela porta delegada (que não as revoga); "vendável" (`isSellableInterface`) = kind T/R fora do
 *    grupo Super — a porta delegada só vincula vendáveis e não lista as do grupo Super.
 *  - D-PV37/D-PV38: "a própria Setes" é a constante `SETES_INSTITUTION_ID` / o predicado `isOwnVendorInstitution`, re-exportados
 *    daqui para as três portas (lista, leitura, escrita) — definidos em `@shared/auth/roles` (módulo-folha, sem ciclo).
 *  - D-AU8 (costura A1, 2026-10-31): sem cache do veredito — toda gravação do contrato vale na hora (a view é lida viva).
 */

export { SETES_INSTITUTION_ID, isOwnVendorInstitution } from '@shared/auth/roles'

/**
 * Telas ESTRUTURAIS do cliente (decisão do Valdo, 2026-08-15 — A2): não são produto vendável, são o mínimo para o admin se virar
 * sozinho; o onboarding as concede a todo cliente novo e a porta delegada NÃO as revoga (D-PV35 — 409 INTERFACE_STRUCTURAL_LOCKED).
 * `general-configs` só entra aqui no dia em que o onboarding a der (D-PV35: "mais general-configs se o onboarding a der").
 */
// D-PV54 (Valdo 2026-10-27): `interface-fields` e `general-configs` também — a gêmea da `interface-configs` e as Configurações Gerais (a
// estrutural só garante que a PORTA existe; quem ajusta segue decidido pelo CONFIGURAR na tela-alvo — D-PV25).
export const STRUCTURAL_INTERFACE_KEYS: readonly string[] = [
  'users', 'modules', 'interface-configs', 'establishment', 'interface-fields', 'general-configs',
]

export function isStructuralInterface(interfaceKey: string | null | undefined): boolean {
  return interfaceKey != null && STRUCTURAL_INTERFACE_KEYS.includes(interfaceKey)
}

/** Grupo do catálogo que NUNCA vai ao menu de cliente nem se vende (regra do menu — `NOT_SUPER_GROUP` do core.repository). */
export const SUPER_GROUP = 'Super'

export interface InterfaceDescriptor {
  id: number
  key: string | null
  kind: string | null
  groupDefault: string | null
}

/** VENDÁVEL (D-PV35): tela ('T') ou recurso ('R') fora do grupo Super. */
export function isSellableInterface(i: Pick<InterfaceDescriptor, 'kind' | 'groupDefault'>): boolean {
  return (i.kind === 'T' || i.kind === 'R') && i.groupDefault !== SUPER_GROUP
}

export async function getInstitutionSchemaName(institutionId: number): Promise<string | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT schema_name AS schemaName
     FROM setes_central.tb_institution
     WHERE id = ? AND deleted = 'N'`,
    [institutionId]
  )
  return rows[0]?.schemaName ?? null
}

/** Uma interface VIVA do catálogo central (null = não existe ou excluída). */
export async function describeInterface(interfaceId: number): Promise<InterfaceDescriptor | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT id, i18n_key AS k, kind, group_default AS groupDefault
       FROM setes_central.tb_interface WHERE id = ? AND deleted = 'N'`,
    [interfaceId]
  )
  const r = rows[0]
  if (!r) return null
  return { id: Number(r.id), key: r.k ?? null, kind: r.kind ?? null, groupDefault: r.groupDefault ?? null }
}

export interface InterfaceGrantRow {
  id:           number
  description:  string | null
  groupDefault: string | null
  kind:         string | null
  granted:      boolean
}

export interface ListGrantOptions {
  /** D-PV35: só as VENDÁVEIS (a porta delegada não mostra o grupo Super). */
  sellableOnly?: boolean
}

/** Catálogo completo (central) + situação do contrato da institution ALVO (pela chave dela — D-GE4). */
export async function listInterfacesWithGrant(
  schemaName: string, institutionId: number, opts: ListGrantOptions = {}
): Promise<InterfaceGrantRow[]> {
  const s = assertSchema(schemaName)
  const sellable = opts.sellableOnly
    ? ` AND i.kind IN ('T', 'R') AND (i.group_default IS NULL OR i.group_default <> ?)`
    : ''
  const params: unknown[] = [institutionId]
  if (opts.sellableOnly) params.push(SUPER_GROUP)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            i.description,
            i.group_default AS groupDefault,
            i.kind,
            CASE WHEN ihi.tb_interface_id IS NOT NULL THEN TRUE ELSE FALSE END AS granted
     FROM setes_central.tb_interface i
     LEFT JOIN \`${s}\`.tb_institution_has_interface ihi
       ON (ihi.tb_interface_id = i.id AND ihi.tb_institution_id = ?
           AND ihi.active = 'S' AND ihi.deleted = 'N')
     WHERE i.deleted = 'N'${sellable}
     ORDER BY i.group_default, i.description`,
    params
  )
  return rows.map(r => ({ ...r, granted: Boolean(r.granted) }))
}

/** O que UMA marca mudou — a TRILHA (quem chama registra com o autor; D-PV33 grava o evento depois da janela). */
export interface InterfaceLinkChange {
  interfaceId: number
  /** Estado DEPOIS da marca (o app reflete este valor — D-PV34). */
  linked: boolean
  /** false = já estava assim (idempotente: conceder o concedido / revogar o revogado não escreve nem gera evento). */
  changed: boolean
}

/**
 * D-PV34 — UMA marca do contrato: concede (`linked: true`) ou revoga (soft, `linked: false`) UMA interface da institution ALVO.
 * Regra ÚNICA das duas portas: interface VIVA do catálogo (400 no campo `interfaceId`), leitura travante da linha
 * (`FOR UPDATE` — duas marcas simultâneas no mesmo par se serializam), idempotente. Vale NA HORA (o veredito lê a view viva — D-AU8).
 */
export async function setInstitutionInterfaceLink(
  schemaName: string, institutionId: number, interfaceId: number, linked: boolean
): Promise<InterfaceLinkChange> {
  const s = assertSchema(schemaName)
  if (!(await describeInterface(interfaceId))) {
    throw new HttpError(400, 'Interface fora do catálogo',
      [{ field: 'interfaceId', message: `Fora do catálogo: ${interfaceId}` }], ErrorCodes.VALIDATION_FAILED)
  }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(
      `SELECT active, deleted FROM \`${s}\`.tb_institution_has_interface
        WHERE tb_institution_id = ? AND tb_interface_id = ? FOR UPDATE`,
      [institutionId, interfaceId]
    )
    const row = rows[0]
    const current = Boolean(row) && row.active === 'S' && row.deleted === 'N'
    if (current === linked) {
      await conn.commit()
      return { interfaceId, linked, changed: false }
    }
    if (linked) {
      if (row) {
        await conn.query(
          `UPDATE \`${s}\`.tb_institution_has_interface
              SET active = 'S', deleted = 'N', updated_at = NOW()
            WHERE tb_institution_id = ? AND tb_interface_id = ?`,
          [institutionId, interfaceId]
        )
      } else {
        // PADROES §9 regra 12: `FOR UPDATE` em PK INEXISTENTE é trava de intervalo (compatível) — duas marcas simultâneas do
        // mesmo par chegariam as duas ao INSERT; a tabela só tem a PK como UNIQUE (regra 10), então o upsert resolve a corrida.
        await conn.query(
          `INSERT INTO \`${s}\`.tb_institution_has_interface
             (tb_institution_id, tb_interface_id, active, created_at, updated_at)
           VALUES (?, ?, 'S', NOW(), NOW())
           ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N', updated_at = NOW()`,
          [institutionId, interfaceId]
        )
      }
    } else {
      await conn.query(
        `UPDATE \`${s}\`.tb_institution_has_interface
            SET active = 'N', updated_at = NOW()
          WHERE tb_institution_id = ? AND tb_interface_id = ?`,
        [institutionId, interfaceId]
      )
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return { interfaceId, linked, changed: true }
}

export interface ClientInstitutionRow { id: number; name: string | null; active: string }

/**
 * Estabelecimentos clientes, PAGINADO (regra: lista nova nasce paginada). `excludeId` tira um estabelecimento da lista (a tela
 * delegada não mostra a própria Setes — D-PV11 (c)/D-PV38).
 */
export async function listClientInstitutions(
  query: ListQuery, excludeId: number | null
): Promise<PagedRows<ClientInstitutionRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_institution i
     INNER JOIN setes_central.tb_entity e ON e.id = i.id
     WHERE i.deleted = 'N'
       AND (? IS NULL OR i.id <> ?)
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)`
  const params = [excludeId, excludeId, like, like, like]
  const [rows] = await pool.query<any[]>(
    `SELECT i.id, COALESCE(NULLIF(e.nick_trade, ''), e.name_company) AS name, i.active
     ${where}
     ORDER BY name, i.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(`SELECT COUNT(*) AS total ${where}`, params)
  return { rows: rows.map(r => ({ id: Number(r.id), name: r.name ?? null, active: String(r.active) })), total: Number(count[0].total) }
}
