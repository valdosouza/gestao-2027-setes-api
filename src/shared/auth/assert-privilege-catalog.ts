import pool from '@shared/db/connection'
import logger from '@shared/logger/logger'
import {
  CONSUMED_PRIVILEGES, PRIVILEGE_ID, MENU_PRIVILEGE, privilegeCatalogProblems, absentMarkHolds,
  CatalogPairRow, PrivilegeDefinitionRow, PrivilegeCatalogProblems, PrivilegeName,
} from '@shared/auth/privilege-catalog'

/**
 * CONFERÊNCIA NO BOOT do catálogo de privilégios — D-PV9 (Valdo 2026-10-18; molde do "boot confere os 9 gatilhos" da F2a,
 * mas SEM recusar subir — a decisão é gritar): a lista única `CONSUMED_PRIVILEGES` contra `setes_central.tb_interface_has_privilege`
 * VIVO e ATIVO, pelo MESMO predicado do leitor que dá os botões do admin e do super (`core.repository.getAllInterfacePrivileges`:
 * vínculo `active='S'`/`deleted='N'` + `tb_privilege` viva) e com a interface viva pelo `i18n_key` (como `require-privilege`, pela
 * regra do banco: sem caixa e sem espaço no fim). Também confere o NOME de cada privilégio consumido (o app compara pela descrição,
 * `toLowerCase` sem trim), nome repetido em outra linha, a regra do menu (VISUALIZAR em toda tela do cliente — `ONLY_SCREEN_KIND` +
 * `NOT_SUPER_GROUP` do `core.repository`) e `i18n_key` repetida ou fora da forma canônica. Falha de leitura = alarme, nunca derruba
 * o boot. Só SELECT no `setes_central`. É a ÚLTIMA linha: antes dela vêm a cerca (jest) e a conferência ao vivo da suíte.
 */
const ALARM = '[ALARME D-PV9]'

/** Telas que o menu do cliente pode mostrar — o filtro de `core.repository` (`ONLY_SCREEN_KIND` + `NOT_SUPER_GROUP`). */
export const MENU_INTERFACES_SQL =
  `SELECT i.i18n_key AS k FROM setes_central.tb_interface i
    WHERE i.deleted = 'N' AND i.kind = 'T' AND COALESCE(i.group_default, '') <> 'Super' AND i.i18n_key IS NOT NULL`

export const CATALOG_PAIRS_SQL =
  `SELECT i.i18n_key AS interfaceKey, ihp.tb_privilege_id AS privilegeId
     FROM setes_central.tb_interface_has_privilege ihp
     INNER JOIN setes_central.tb_interface i ON (i.id = ihp.tb_interface_id AND i.deleted = 'N')
     INNER JOIN setes_central.tb_privilege p ON (p.id = ihp.tb_privilege_id AND p.deleted = 'N')
    WHERE ihp.active = 'S' AND ihp.deleted = 'N'`

export const PRIVILEGES_SQL = `SELECT id, description FROM setes_central.tb_privilege WHERE deleted = 'N'`

/** Todas as `i18n_key` vivas (a coluna não é UNIQUE) — repetição e forma canônica são conferidas na peça pura. */
export const INTERFACE_KEYS_SQL =
  `SELECT i.i18n_key AS k FROM setes_central.tb_interface i WHERE i.deleted = 'N' AND i.i18n_key IS NOT NULL`

const pairText = (k: string, p: PrivilegeName): string => `${k} × ${p} (${PRIVILEGE_ID[p]})`

/** As linhas de alarme (uma por classe de problema) — pura, para o teste e para o script de conferência. */
export function privilegeCatalogAlarms(p: PrivilegeCatalogProblems): string[] {
  const out: string[] = []
  if (p.missing.length) {
    out.push(`${ALARM} ${p.missing.length} par(es) que o código consome SEM vínculo vivo e ativo no catálogo — o botão some até do admin ` +
      `e o par não pode ser concedido: ${p.missing.map(m => pairText(m.interface, m.privilege)).join(', ')}. ` +
      'Falta o seed dos pares (por i18n_key) em setes_central.tb_interface_has_privilege.')
  }
  if (p.misnamed.length) {
    out.push(`${ALARM} privilégio consumido sem linha viva ou com nome trocado em tb_privilege — o app compara pelo NOME: ` +
      `${p.misnamed.map(m => `${m.id} esperado "${m.privilege}", achado ${m.description === null ? 'nada' : `"${m.description}"`}`).join(', ')}.`)
  }
  if (p.duplicateNames.length) {
    out.push(`${ALARM} nome de privilégio consumido repetido em outra linha de tb_privilege — o app libera o botão por QUALQUER linha com ` +
      `o nome e a API decide pelo id: ${p.duplicateNames.map(d => `${d.privilege} (id ${d.id}; também ${d.otherIds.join(', ')})`).join(', ')}.`)
  }
  if (p.menuWithoutView.length) {
    out.push(`${ALARM} ${p.menuWithoutView.length} tela(s) do cliente sem ${MENU_PRIVILEGE} no catálogo — nunca entram no menu de um ` +
      `usuário regular (C2): ${p.menuWithoutView.join(', ')}.`)
  }
  if (p.duplicateKeys.length) {
    out.push(`${ALARM} i18n_key repetida em interfaces vivas — a guarda resolve por LIMIT 1 sem ordem e o menu pelo id; o par pode estar ` +
      `numa linha e o botão olhar a outra: ${p.duplicateKeys.join(', ')}.`)
  }
  if (p.nonCanonicalKeys.length) {
    out.push(`${ALARM} i18n_key fora da forma canônica (minúsculas, sem espaço nas pontas) — a guarda acha pela colação do banco, mas o ` +
      `app e esta conferência comparam exato: ${p.nonCanonicalKeys.join(', ')}.`)
  }
  if (p.absentButPresent.length) {
    out.push(`${ALARM} par marcado "ausente por decisão" na lista já está no catálogo — tirar a marca absentBy de ` +
      `src/shared/auth/privilege-catalog.ts: ${p.absentButPresent.map(a => pairText(a.interface, a.privilege)).join(', ')}.`)
  }
  return out
}

/** Lê o catálogo e devolve os problemas (sem log) — usada pelo boot, pelo `scripts/check-privilege-catalog.ts` e pela suíte. */
export async function readPrivilegeCatalogProblems(): Promise<PrivilegeCatalogProblems> {
  const rowsOf = (r: unknown): any[] => (Array.isArray(r) ? r : [])
  const [catalog] = await pool.query<any[]>(CATALOG_PAIRS_SQL)
  const [privileges] = await pool.query<any[]>(PRIVILEGES_SQL)
  const [menu] = await pool.query<any[]>(MENU_INTERFACES_SQL)
  const [keys] = await pool.query<any[]>(INTERFACE_KEYS_SQL)
  return privilegeCatalogProblems(
    rowsOf(catalog).map((r): CatalogPairRow => ({ interfaceKey: String(r?.interfaceKey), privilegeId: Number(r?.privilegeId) })),
    rowsOf(privileges).map((r): PrivilegeDefinitionRow => ({ id: Number(r?.id), description: r?.description == null ? null : String(r.description) })),
    rowsOf(menu).map(r => String(r?.k)),
    CONSUMED_PRIVILEGES,
    rowsOf(keys).map(r => String(r?.k)),
  )
}

/** Texto do erro sem nunca lançar (um getter de `.message` que lança derrubaria o boot pelo `catch` do server.ts). */
function errorText(err: unknown): string {
  try { return err instanceof Error ? err.message : String(err) } catch { return 'erro ilegível' }
}

/** Boot: confere, grita cada problema no log e devolve o resumo. NUNCA lança (D-PV9: alarme, sem recusar subir). */
export async function assertPrivilegeCatalog(): Promise<string> {
  try {
    const problems = await readPrivilegeCatalogProblems()
    const alarms = privilegeCatalogAlarms(problems)
    for (const a of alarms) { try { logger.warn(a) } catch { /* o log falhou, não a leitura — o resumo segue certo */ } }
    const absent = CONSUMED_PRIVILEGES.filter(absentMarkHolds).length
    const required = CONSUMED_PRIVILEGES.length - absent
    if (alarms.length === 0) return `OK — ${required} par(es) consumido(s) no catálogo (${absent} ausente(s) por decisão)`
    return `ALARME — ${problems.missing.length} par(es) faltando, ${problems.misnamed.length + problems.duplicateNames.length} nome(s) ` +
      `trocado(s)/repetido(s), ${problems.menuWithoutView.length} tela(s) sem ${MENU_PRIVILEGE}, ` +
      `${problems.duplicateKeys.length + problems.nonCanonicalKeys.length} i18n_key ambígua(s) (ver avisos)`
  } catch (err) {
    try { logger.warn(`${ALARM} não foi possível conferir o catálogo de privilégios: ${errorText(err)}`) } catch { /* nunca derruba o boot */ }
    return 'NÃO CONFERIDO (falha de leitura — ver alarme)'
  }
}
