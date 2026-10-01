import { InstitutionPayload } from '@shared/types/express'
import pool from '@shared/db/connection'
import { getConfigContent } from '@shared/interface-config'
import { operationNow } from './operation-clock'
export { runWithOperationClock, operationNow } from './operation-clock'

/**
 * FUSO DO ESTABELECIMENTO (Q-BA14, Valdo 2026-09-30; parecer do guardião):
 * a zona IANA em que o sistema lê o relógio do estabelecimento — o que é
 * "hoje" e qual faixa de instantes forma um dia do calendário. Mora no
 * Framework de Configurações (interface 'establishment', config `time_zone`,
 * scope I, seed 60) — sem cache próprio: herda o TTL do interface-config.
 *
 * Fronteira: NÃO formata data para tela (é do app), NÃO executa SQL de
 * negócio e NÃO dita o fuso da sessão do banco (é da conexão). As conversões
 * usam Intl (ICU do Node) — nenhuma lib nova.
 */

export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo'

/** Zona IANA válida para o Intl? (config corrompida nunca derruba a leitura) */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** Zona do estabelecimento do JWT (config `time_zone`; inválida/ausente = default). */
export async function institutionZone(payload: InstitutionPayload): Promise<string> {
  const zone = await getConfigContent(payload, 'establishment', 'time_zone')
  return zone && isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE
}

/** Qualquer coisa que execute SQL: o pool ou a CONEXÃO da transação em curso. */
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<any>
}

const ZONE_TTL_MS = Number(process.env.TIME_ZONE_CACHE_TTL_MS ?? 60_000)
const zoneCache = new Map<string, { zone: string; expires: number }>()

/** Esquece a zona em cache (após salvar a config `time_zone`; senão vale o TTL). */
export function invalidateInstitutionZone(schemaName?: string, institutionId?: number): void {
  if (schemaName === undefined) zoneCache.clear()
  else zoneCache.delete(`${schemaName}|${institutionId}`)
}

/**
 * Zona do estabelecimento sem JWT (pipelines, peças). C1 do gate socrático da onda
 * TZ-1 (2026-09-30): DENTRO DE TRANSAÇÃO passe a conexão dela em [q] — a leitura
 * vai por ela, NUNCA por uma 2ª conexão do pool (padrão que já travou a API: 20
 * transações segurando as 20 conexões à espera de uma 21ª — ver o aviso em
 * getConfigContentFor). Uma consulta só (catálogo + valor da institution), leitura
 * não travante; cache próprio por TTL.
 */
export async function institutionZoneFor(
  schemaName: string, institutionId: number, q: Queryable = pool
): Promise<string> {
  const key = `${schemaName}|${institutionId}`
  const hit = zoneCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.zone
  if (!/^[A-Za-z0-9_]+$/.test(schemaName)) return DEFAULT_TIME_ZONE
  const [rows] = await q.query(
    `SELECT COALESCE(v.content, c.default_content) AS zone
       FROM setes_central.tb_interface i
       JOIN setes_central.tb_interface_has_config c
         ON c.tb_interface_id = i.id AND c.name = 'time_zone' AND c.deleted = 'N'
       LEFT JOIN \`${schemaName}\`.tb_institution_has_config v
         ON v.tb_interface_id = i.id AND v.name = 'time_zone' AND v.tb_institution_id = ?
        AND v.tb_user_id = 0 AND v.deleted = 'N'
      WHERE i.i18n_key = 'establishment' AND i.deleted = 'N'
      LIMIT 1`,
    [institutionId]
  )
  const raw = (rows as any[])?.[0]?.zone
  const zone = typeof raw === 'string' && raw !== '' && isValidTimeZone(raw) ? raw : DEFAULT_TIME_ZONE   // estrito, como institutionZone
  zoneCache.set(key, { zone, expires: Date.now() + ZONE_TTL_MS })
  return zone
}

/**
 * Agora (ou [d]) como ISO com o offset DA ZONA: 'YYYY-MM-DDThh:mm:ss±hh:mm'.
 * Q-TZ2 (Valdo 2026-09-30): o dhEmi/dhEvento da NFS-e é a hora do ESTABELECIMENTO —
 * nunca o fuso do processo Node (servidor em UTC mandaria -00:00 ao fisco).
 */
export function nowIsoIn(zone: string, d: Date = new Date()): string {
  const ms = Math.floor(d.getTime() / 1000) * 1000
  const off = offsetMs(zone, ms)
  const wall = new Date(ms + off).toISOString().slice(0, 19)
  const mins = Math.round(off / 60000)
  const sign = mins >= 0 ? '+' : '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${wall}${sign}${p(Math.floor(Math.abs(mins) / 60))}:${p(Math.abs(mins) % 60)}`
}

/** Offset (ms) da zona no instante [utcMs]: horaLocal − horaUTC. */
function offsetMs(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wall - Math.floor(utcMs / 1000) * 1000
}

/** 'YYYY-MM-DD' de hoje na zona. */
export function todayIn(zone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/**
 * Instante UTC ('YYYY-MM-DD HH:MM:SS') em que o dia [isoDate] COMEÇA na zona.
 * Candidatos = meia-noite local pelos offsets vizinhos; vale o MENOR cuja data
 * local é o próprio dia. Cobre o dia em que a meia-noite NÃO EXISTE (início do
 * horário de verão à 0h — SP 04/11/2018 começou à 01:00 local = 03:00Z).
 */
export function dayStartUtc(isoDate: string, zone: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const wallMs = Date.UTC(y, m - 1, d)
  const first = wallMs - offsetMs(zone, wallMs)
  const second = wallMs - offsetMs(zone, first)
  const inDay = [first, second]
    .filter(ms => todayIn(zone, new Date(ms)) === isoDate)
    .sort((a, b) => a - b)
  const utc = inDay[0] ?? Math.max(first, second)
  return new Date(utc).toISOString().slice(0, 19).replace('T', ' ')
}

/** Dia seguinte de um 'YYYY-MM-DD' (calendário puro, sem fuso). */
export function nextDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/** "Hoje" do estabelecimento ('YYYY-MM-DD') — a DATA DE NEGÓCIO da casa (Q-TZ1).
 *  Substitui CURDATE()/new Date() em todo fato com data de calendário.
 *  DENTRO DE TRANSAÇÃO: passe a conexão dela em [q] (C1 — nunca 2ª conexão do pool). */
export async function todayFor(
  schemaName: string, institutionId: number, q: Queryable = pool,
  now: Date = operationNow() ?? new Date()   // Q-TZ8: relógio ÚNICO da operação
): Promise<string> {
  return todayIn(await institutionZoneFor(schemaName, institutionId, q), now)
}

/** Ano-mês ('YYYY-MM') de [d] na zona — pastas fiscais por mês contábil. */
export function monthIn(zone: string, d: Date = new Date()): string {
  return todayIn(zone, d).slice(0, 7)
}

function pad(n: number): string { return String(n).padStart(2, '0') }

/**
 * Instante UTC do banco ('YYYY-MM-DD HH:MM:SS', ou Date do driver) → hora de
 * parede NA ZONA, mesmo formato. É assim que todo instante com hora é devolvido
 * ao app (Q-TZ1: banco em UTC, apresentação na zona do estabelecimento).
 */
export function toZoneWall(utc: string | Date | null | undefined, zone: string): string | null {
  if (utc === null || utc === undefined || utc === '') return null
  // só DATETIME do banco ('YYYY-MM-DD[ HH:MM[:SS]]') ou Date — '12345' não é ano 12345 (LOW do adversarial)
  if (!(utc instanceof Date) && !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(String(utc))) return null
  const ms = utc instanceof Date ? utc.getTime() : Date.parse(`${String(utc).replace(' ', 'T')}Z`)
  if (Number.isNaN(ms)) return null
  return new Date(ms + offsetMs(zone, ms)).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Data/hora COM offset (voz do fisco/banco: '2026-09-30T22:00:00-03:00', 'Z')
 * → instante UTC para gravar ('YYYY-MM-DD HH:MM:SS'). Sem offset, a hora é
 * lida como parede de [zone]. Inválido = null.
 */
export function toUtcDb(value: string | null | undefined, zone: string = DEFAULT_TIME_ZONE): string | null {
  if (!value) return null
  const v = String(value).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(v)
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', se = '00', tz] = m
  // LOW do adversarial: data/hora IMPOSSÍVEL vira null (Date.UTC "rolaria" 30/02 → 02/03; ano < 1000 → 19xx)
  const daysIn = new Date(Date.UTC(+y, +mo, 0)).getUTCDate()
  if (+y < 1000 || +mo < 1 || +mo > 12 || +d < 1 || +d > daysIn) return null
  if (+mi > 59 || +se > 59 || +h > 24 || (+h === 24 && (+mi > 0 || +se > 0))) return null
  if (tz && tz !== 'Z') {
    const digits = tz.slice(1).replace(':', '')
    if (Number(digits.slice(0, 2)) > 14 || Number(digits.slice(2)) > 59) return null
  }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)
  let utc: number
  if (tz) {
    const sign = tz === 'Z' ? 0 : tz[0] === '-' ? -1 : 1
    const digits = tz === 'Z' ? '0000' : tz.slice(1).replace(':', '')
    utc = wall - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000
  } else {
    utc = wall - offsetMs(zone, wall)
    utc = wall - offsetMs(zone, utc)
  }
  const dt = new Date(utc)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`
}

/**
 * Apresentação (Q-TZ1): devolve [row] com os campos-INSTANTE [keys] (UTC do banco,
 * 'YYYY-MM-DD HH:MM:SS') convertidos para a hora de parede da ZONA. Usado só na
 * FRONTEIRA HTTP — a lógica interna continua comparando instantes em UTC.
 */
export function withZoneWall<T extends object>(row: T, keys: readonly (keyof T)[], zone: string): T {
  const out = { ...row }
  for (const k of keys) {
    const v = out[k] as unknown
    if (typeof v === 'string' || v instanceof Date) (out as any)[k] = toZoneWall(v, zone)
  }
  return out
}

/**
 * Fim da janela de TRANSIÇÃO (Q-TZ3, data de corte): a sessão do banco passou a UTC em
 * 2026-09-30 ~22h de Brasília. Voz de terceiro gravada ANTES disso está em hora de parede
 * de Brasília; a idempotência só casa essa forma antiga para valores ANTERIORES ao corte
 * (fecha o LOW do adversarial: sem corte, uma voz real 3h após outra seria engolida).
 */
export const TZ_CUTOVER_WALL = '2026-10-01 00:00:00'

/** Forma ANTIGA (parede de Brasília) do instante UTC [dt], só se anterior ao corte; senão null. */
export function legacyWallBeforeCutover(dt: string | null): string | null {
  const wall = toZoneWall(dt, DEFAULT_TIME_ZONE)
  return wall !== null && wall < TZ_CUTOVER_WALL ? wall : null
}
