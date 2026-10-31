import pool from '@shared/db/connection'
import logger from '@shared/logger/logger'
import { listGatedModules } from '@shared/auth/module-privilege-gate'
import {
  PRIVILEGE_ID, MENU_PRIVILEGE, CONFIGURE_PRIVILEGE, RESERVED_PRIVILEGES, privilegeCatalogProblems, absentMarkHolds, consumedPrivileges,
  CatalogPairRow, PrivilegeDefinitionRow, PrivilegeCatalogProblems, PrivilegeName, ConsumedPrivilege,
} from '@shared/auth/privilege-catalog'

/**
 * CONFERÊNCIA NO BOOT do catálogo de privilégios — D-PV9 (Valdo 2026-10-18; molde do "boot confere os 9 gatilhos" da F2a, mas SEM
 * recusar subir — D-PV52, Valdo 2026-10-27: "manter o alarme no boot; o gate é o teste e a publicação"; conhecimento negativo: não
 * "endurecer" o boot depois). A IGUALDADE da D-PV51, por interface: o registro VIVO e ATIVO (`setes_central.tb_interface_has_privilege`,
 * pelo MESMO predicado da view `vw_user_access` — vínculo `active='S'`/`deleted='N'` + `tb_privilege` viva + interface viva) tem de ser
 * igual a: o que o código opera (`consumedPrivileges()` — a lista à mão ∪ a tabela do roteador, D-PV14) ∪ VISUALIZAR em toda tela (o
 * menu) ∪ CONFIGURAR em toda interface com config/campo + `general-configs` (D-PV25) ∪ os reservados. Uma linha `[ALARME D-PV9]` por
 * classe: par faltando, par SOBRANDO (D-PV51), nome trocado/repetido (app e view comparam pelo NOME), tela sem VISUALIZAR, interface sem
 * CONFIGURAR, reservado fora do catálogo, marca `absentBy` desatualizada, `i18n_key` repetida ou fora da forma (D-PV42). Falha de leitura
 * = alarme, nunca derruba o boot. Só SELECT no `setes_central`. É a ÚLTIMA linha: antes dela vêm a cerca (jest), o teste ao vivo e a
 * publicação (D-PV16).
 */
const ALARM = '[ALARME D-PV9]'

/** Telas (kind 'T', inclusive o grupo Super) — a REGRA do menu: o menu de qualquer perfil só mostra a tela com VISUALIZAR (core.service). */
export const SCREEN_INTERFACES_SQL =
  `SELECT i.i18n_key AS k FROM setes_central.tb_interface i
    WHERE i.deleted = 'N' AND i.kind = 'T' AND i.i18n_key IS NOT NULL`

/** Interfaces com config ou campo VIVO no catálogo — a REGRA do CONFIGURAR (o MESMO critério do seed 68). */
export const CONFIGURABLE_INTERFACES_SQL =
  `SELECT i.i18n_key AS k FROM setes_central.tb_interface i
    WHERE i.deleted = 'N' AND i.i18n_key IS NOT NULL
      AND (EXISTS (SELECT 1 FROM setes_central.tb_interface_has_config c WHERE c.tb_interface_id = i.id AND c.deleted = 'N')
        OR EXISTS (SELECT 1 FROM setes_central.tb_interface_has_field f WHERE f.tb_interface_id = i.id AND f.deleted = 'N'))`

/** O registro vivo e ativo — o MESMO predicado da `vw_user_access` (migration 075) sobre a `vw_interface_catalog` (sql/70). */
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
    out.push(`${ALARM} ${p.missing.length} par(es) que o código opera SEM vínculo vivo e ativo no catálogo — o botão some e a ação é ` +
      `negada até do admin: ${p.missing.map(m => pairText(m.interface, m.privilege)).join(', ')}. ` +
      'Falta o seed dos pares (por i18n_key) em setes_central.tb_interface_has_privilege.')
  }
  if (p.surplus.length) {
    out.push(`${ALARM} ${p.surplus.length} par(es) REGISTRADO(S) que nenhum código opera (D-PV51) — promessa falsa na tela de permissões: ` +
      `${p.surplus.map(s => `${s.interface} × ${s.privilege ?? s.description ?? '?'} (${s.privilegeId})`).join(', ')}. ` +
      'Retirar do catálogo (soft delete — D-PR37) ou marcar como reservado COM a decisão (RESERVED_PRIVILEGES).')
  }
  if (p.misnamed.length) {
    out.push(`${ALARM} privilégio consumido sem linha viva ou com nome trocado em tb_privilege — app e view comparam pelo NOME: ` +
      `${p.misnamed.map(m => `${m.id} esperado "${m.privilege}", achado ${m.description === null ? 'nada' : `"${m.description}"`}`).join(', ')}.`)
  }
  if (p.duplicateNames.length) {
    out.push(`${ALARM} nome de privilégio consumido repetido em outra linha de tb_privilege — o app libera o botão por QUALQUER linha com ` +
      `o nome e a API decide pelo id: ${p.duplicateNames.map(d => `${d.privilege} (id ${d.id}; também ${d.otherIds.join(', ')})`).join(', ')}.`)
  }
  if (p.menuWithoutView.length) {
    out.push(`${ALARM} ${p.menuWithoutView.length} tela(s) sem ${MENU_PRIVILEGE} no catálogo — nunca entram no menu de ninguém (C2; no ` +
      `grupo Super, nem no do super): ${p.menuWithoutView.join(', ')}.`)
  }
  if (p.configureMissing.length) {
    out.push(`${ALARM} ${p.configureMissing.length} interface(s) com config ou campo no catálogo (ou Configurações Gerais) sem ` +
      `${CONFIGURE_PRIVILEGE} — a engrenagem some e o valor da institution não se grava (D-PV25): ${p.configureMissing.join(', ')}.`)
  }
  if (p.reservedAbsent.length) {
    out.push(`${ALARM} par RESERVADO por decisão fora do catálogo — falta o seed, ou a marca apodreceu (RESERVED_PRIVILEGES em ` +
      `src/shared/auth/privilege-catalog.ts): ${p.reservedAbsent.map(a => pairText(a.interface, a.privilege)).join(', ')}.`)
  }
  if (p.duplicateKeys.length) {
    out.push(`${ALARM} i18n_key repetida em interfaces vivas — a resolução por chave pega uma linha sem ordem e o menu pelo id; o par pode ` +
      `estar numa linha e o botão olhar a outra: ${p.duplicateKeys.join(', ')}.`)
  }
  if (p.nonCanonicalKeys.length) {
    out.push(`${ALARM} i18n_key fora da forma canônica (D-PV42: começa por letra; minúsculas, dígitos e hífen) — a guarda acha pela ` +
      `colação do banco, mas o app e esta conferência comparam exato: ${p.nonCanonicalKeys.join(', ')}.`)
  }
  if (p.absentButPresent.length) {
    out.push(`${ALARM} par marcado "ausente por decisão" na lista já está no catálogo — tirar o par do catálogo ou a marca absentBy de ` +
      `src/shared/auth/privilege-catalog.ts: ${p.absentButPresent.map(a => pairText(a.interface, a.privilege)).join(', ')}.`)
  }
  return out
}

/**
 * Lê o catálogo e devolve os problemas (sem log) — usada pelo boot, pelo `scripts/check-privilege-catalog.ts` e pelo teste ao vivo.
 * `consumed` padrão = `consumedPrivileges()`: o gateway tem de estar montado (no boot está; o script e o teste o importam antes).
 */
export async function readPrivilegeCatalogProblems(
  consumed: readonly ConsumedPrivilege[] = consumedPrivileges(),
): Promise<PrivilegeCatalogProblems> {
  const rowsOf = (r: unknown): any[] => (Array.isArray(r) ? r : [])
  const [catalog] = await pool.query<any[]>(CATALOG_PAIRS_SQL)
  const [privileges] = await pool.query<any[]>(PRIVILEGES_SQL)
  const [screens] = await pool.query<any[]>(SCREEN_INTERFACES_SQL)
  const [configurable] = await pool.query<any[]>(CONFIGURABLE_INTERFACES_SQL)
  const [keys] = await pool.query<any[]>(INTERFACE_KEYS_SQL)
  return privilegeCatalogProblems({
    catalog: rowsOf(catalog).map((r): CatalogPairRow => ({ interfaceKey: String(r?.interfaceKey), privilegeId: Number(r?.privilegeId) })),
    privileges: rowsOf(privileges).map((r): PrivilegeDefinitionRow => ({ id: Number(r?.id), description: r?.description == null ? null : String(r.description) })),
    screens: rowsOf(screens).map(r => String(r?.k)),
    configurable: rowsOf(configurable).map(r => String(r?.k)),
    interfaceKeys: rowsOf(keys).map(r => String(r?.k)),
  }, consumed, RESERVED_PRIVILEGES)
}

/** Texto do erro sem nunca lançar (um getter de `.message` que lança derrubaria o boot pelo `catch` do server.ts). */
function errorText(err: unknown): string {
  try { return err instanceof Error ? err.message : String(err) } catch { return 'erro ilegível' }
}

const warnSafely = (line: string): void => { try { logger.warn(line) } catch { /* o log falhou, não a leitura — o resumo segue certo */ } }

/** Boot: confere, grita cada problema no log e devolve o resumo. NUNCA lança (D-PV9/D-PV52: alarme, sem recusar subir). */
export async function assertPrivilegeCatalog(): Promise<string> {
  try {
    // a tabela do roteador vazia = o gateway não foi montado: os pares da guarda por roteador não seriam conferidos (D-PV14)
    if (listGatedModules().length === 0) {
      warnSafely(`${ALARM} a tabela da guarda por roteador está VAZIA — os pares dela (D-PV2/D-PV14) não foram conferidos`)
    }
    const consumed = consumedPrivileges()
    const problems = await readPrivilegeCatalogProblems(consumed)
    const alarms = privilegeCatalogAlarms(problems)
    for (const a of alarms) warnSafely(a)
    const absent = consumed.filter(absentMarkHolds).length
    const required = consumed.length - absent
    if (alarms.length === 0) {
      return `OK — ${required} par(es) operado(s) no catálogo (${absent} ausente(s) por decisão, ${RESERVED_PRIVILEGES.length} reservado(s))`
    }
    return `ALARME — ${problems.missing.length} par(es) faltando, ${problems.surplus.length} sobrando, ` +
      `${problems.misnamed.length + problems.duplicateNames.length} nome(s) trocado(s)/repetido(s), ` +
      `${problems.menuWithoutView.length} tela(s) sem ${MENU_PRIVILEGE}, ${problems.configureMissing.length} sem ${CONFIGURE_PRIVILEGE}, ` +
      `${problems.duplicateKeys.length + problems.nonCanonicalKeys.length} i18n_key ambígua(s) (ver avisos)`
  } catch (err) {
    warnSafely(`${ALARM} não foi possível conferir o catálogo de privilégios: ${errorText(err)}`)
    return 'NÃO CONFERIDO (falha de leitura — ver alarme)'
  }
}
