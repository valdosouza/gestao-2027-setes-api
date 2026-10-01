/// <reference types="jest" />
/**
 * GATE ADVERSARIAL — Fuso do estabelecimento, onda TZ-1 (2026-09-30).
 * Alvo: @shared/time-zone (+ consumidores: compileCriteria storage 'datetime',
 * idempotência hasRegistrationEvent/hasTransmissionEvent). Ver
 * Infra-IA/prompts/prompt_pesquisa_avancada.md §9.3/§10 e a skill
 * Infra-IA/skills-genericas/testar-adversarial.md.
 *
 * Achado CONFIRMADO fica fixado com `it.failing` (verde enquanto o bug existe;
 * quando corrigido o teste fica VERMELHO — trocar `it.failing` por `it`).
 * 2026-09-30: MEDIUM (9999-12-31) e os 3 LOW de entrada CORRIGIDOS — viraram `it`.
 */

jest.mock('@shared/interface-config', () => ({
  getConfigContent:    jest.fn(),
  getConfigContentFor: jest.fn(),
}))
jest.mock('@shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))

import { getConfigContent, getConfigContentFor } from '@shared/interface-config'
import { compileCriteria, SearchCriterion } from '../shared/list/search-criteria'
import { hasRegistrationEvent } from '../shared/bank-slip-registration/registration.repository'
import { hasTransmissionEvent } from '../shared/invoice-transmission/transmission.repository'

// a peça REAL (o setup global só fixa a resolução pelo banco)
const tz = jest.requireActual('@shared/time-zone') as typeof import('../shared/time-zone')
const { nowIsoIn, todayIn, toZoneWall, toUtcDb, dayStartUtc, nextDay, withZoneWall,
  institutionZone, institutionZoneFor, isValidTimeZone, DEFAULT_TIME_ZONE } = tz

const BR_ZONES = ['America/Noronha', 'America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco']
const DST_ZONES = ['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata',
  'America/St_Johns', 'Pacific/Chatham', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']
const ALL = [...BR_ZONES, ...DST_ZONES]

// PRNG determinístico (falha reproduzível)
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) }
const MIN = Date.UTC(1970, 0, 1), MAX = Date.UTC(2100, 11, 31)
const fmtUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

describe('propriedades — instantes aleatórios 1970–2100', () => {
  const r = rng(42)
  const instants = Array.from({ length: 1500 }, () => Math.floor((MIN + r() * (MAX - MIN)) / 1000) * 1000)

  it.each(ALL)('%s: toUtcDb(toZoneWall(utc)) == utc, exceto a hora REPETIDA do fim do DST', zone => {
    const bad: string[] = []
    for (const ms of instants) {
      const utc = fmtUtc(ms)
      const wall = toZoneWall(utc, zone)!
      const back = toUtcDb(wall, zone)
      if (back !== utc) {
        // só é aceitável se a hora de parede é AMBÍGUA (existe com dois offsets)
        const alt = toZoneWall(back!, zone)
        if (alt !== wall) bad.push(`${utc} → ${wall} → ${back}`)
      }
    }
    expect(bad).toEqual([])
  })

  it.each(ALL)('%s: todayIn == data de nowIsoIn, e o offset do nowIsoIn reconstrói o instante', zone => {
    for (const ms of instants.slice(0, 500)) {
      const iso = nowIsoIn(zone, new Date(ms))
      expect(iso.slice(0, 10)).toBe(todayIn(zone, new Date(ms)))
      expect(Date.parse(iso)).toBe(ms)
    }
  })

  it.each(ALL)('%s: dayStartUtc é EXATAMENTE o 1º segundo do dia na zona', zone => {
    const r2 = rng(7)
    for (let i = 0; i < 400; i++) {
      const day = new Date(MIN + Math.floor(r2() * (MAX - MIN))).toISOString().slice(0, 10)
      const start = Date.parse(dayStartUtc(day, zone).replace(' ', 'T') + 'Z')
      const end = Date.parse(dayStartUtc(nextDay(day), zone).replace(' ', 'T') + 'Z')
      expect(todayIn(zone, new Date(start))).toBe(day)
      expect(todayIn(zone, new Date(start - 1000))).not.toBe(day)
      expect(todayIn(zone, new Date(end - 1000))).toBe(day)
      expect(end).toBeGreaterThan(start)
    }
  })

  it('transições de DST à MEIA-NOITE de SP (início 2018-11-04 e fim 2019-02-17)', () => {
    expect(dayStartUtc('2018-11-04', 'America/Sao_Paulo')).toBe('2018-11-04 03:00:00') // 0h não existiu
    expect(dayStartUtc('2019-02-17', 'America/Sao_Paulo')).toBe('2019-02-17 03:00:00') // 23h do dia 16 repetiu
    expect(dayStartUtc('2019-02-16', 'America/Sao_Paulo')).toBe('2019-02-16 02:00:00')
  })

  it('DOCUMENTA: parede inexistente (gap do DST) cai 1h ANTES — 2018-11-04 00:30 SP vira 03/11 23:30 local', () => {
    const utc = toUtcDb('2018-11-04 00:30:00', 'America/Sao_Paulo')!
    expect(toZoneWall(utc, 'America/Sao_Paulo')).toBe('2018-11-03 23:30:00')
  })

  it('DOCUMENTA: Pacific/Apia pulou 2011-12-30 inteiro — dayStartUtc devolve um instante de outro dia', () => {
    const s = dayStartUtc('2011-12-30', 'Pacific/Apia')
    expect(todayIn('Pacific/Apia', new Date(s.replace(' ', 'T') + 'Z'))).not.toBe('2011-12-30')
  })
})

describe('entradas hostis — toUtcDb / toZoneWall / nowIsoIn', () => {
  it.each([
    'lixo', '2026-9-30', '30/09/2026', '2026-09-30T10', '2026-09-30T10:00:00 -03', '2026-09-30TZ', '   ',
  ])('toUtcDb(%p) = null, sem lançar', v => {
    expect(() => toUtcDb(v)).not.toThrow()
    expect(toUtcDb(v)).toBeNull()
  })

  it('offsets válidos e extremos (+14:00/-12:00, +0300, " Z")', () => {
    expect(toUtcDb('2026-09-30T10:00:00+14:00')).toBe('2026-09-29 20:00:00')
    expect(toUtcDb('2026-09-30T10:00:00-12:00')).toBe('2026-09-30 22:00:00')
    expect(toUtcDb('2026-09-30T10:00:00+0300')).toBe('2026-09-30 07:00:00')
    expect(toUtcDb('2026-09-30T10:00:00 Z')).toBe('2026-09-30 10:00:00')
    expect(toUtcDb('2026-09-30T10:00:00.999-03:00')).toBe('2026-09-30 13:00:00')
    expect(toUtcDb('2026-09-30')).toBe('2026-09-30 03:00:00')            // data pura = 0h de Brasília
    expect(toUtcDb('2026-09-30T24:00:00Z')).toBe('2026-10-01 00:00:00')  // ISO 8601 permite 24:00
  })

  // LOW (analisado/provado): data de calendário IMPOSSÍVEL é normalizada em silêncio
  // (Date.UTC "rola") em vez de virar null. Voz de banco/fisco nunca manda isso na
  // prática; registrado para não ser invocado como garantia.
  it('LOW: toUtcDb recusa data impossível (2026-02-30, mês 13, hora 99, offset +99:99)', () => {
    expect(toUtcDb('2026-02-30T10:00:00Z')).toBeNull()      // hoje: '2026-03-02 10:00:00'
    expect(toUtcDb('2026-13-01')).toBeNull()                // hoje: '2027-01-01 03:00:00'
    expect(toUtcDb('2026-09-30T99:99:99Z')).toBeNull()
    expect(toUtcDb('2026-09-30T10:00:00+99:99')).toBeNull()
  })

  it('LOW: toUtcDb com ano 0000–0099 não vira 19xx (Date.UTC mapeia 0..99 → 1900..1999)', () => {
    expect(toUtcDb('0050-01-01T00:00:00Z')).not.toBe('1950-01-01 00:00:00')
  })

  it('toZoneWall: Date inválida, número, string vazia, lixo → null sem lançar', () => {
    expect(toZoneWall(new Date('x'), 'America/Sao_Paulo')).toBeNull()
    expect(toZoneWall('', 'America/Sao_Paulo')).toBeNull()
    expect(toZoneWall(undefined, 'America/Sao_Paulo')).toBeNull()
    expect(toZoneWall('2026-09-30 10:00:00Z', 'America/Sao_Paulo')).toBeNull()
  })

  // LOW (provado): string só de dígitos ('12345') é lida como ANO 12345 e devolve
  // '+012344-12-31 21:00' (formato quebrado, sem segundos). Não é alcançável hoje:
  // withZoneWall só repassa string/Date vindas de DATETIME do banco.
  it('LOW: toZoneWall recusa string que não é DATETIME (12345)', () => {
    expect(toZoneWall('12345', 'America/Sao_Paulo')).toBeNull()
  })

  it('withZoneWall só converte string/Date; null/number passam intactos e o objeto original não muda', () => {
    const row = { a: '2026-10-01 01:00:30', b: null as any, c: 5 as any, d: new Date('2026-10-01T01:00:30Z') }
    const out = withZoneWall(row, ['a', 'b', 'c', 'd'], 'America/Manaus')
    expect(out).toEqual({ a: '2026-09-30 21:00:30', b: null, c: 5, d: '2026-09-30 21:00:30' })
    expect(row.a).toBe('2026-10-01 01:00:30')
  })

  it('zona inválida chegando direto às puras LANÇA (por isso a resolução filtra — ver abaixo)', () => {
    expect(() => todayIn('Foo/Bar')).toThrow(RangeError)
    expect(isValidTimeZone('Foo/Bar')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('resolução da zona — config corrompida → default', () => {
  const payload = { institutionId: 1, schemaName: 'setes_x', userId: 1 } as any
  it.each([
    [null, DEFAULT_TIME_ZONE], ['', DEFAULT_TIME_ZONE], ['Foo/Bar', DEFAULT_TIME_ZONE],
    ['America/Manaus ', DEFAULT_TIME_ZONE], ["'; DROP TABLE x --", DEFAULT_TIME_ZONE],
    ['America/Manaus', 'America/Manaus'], ['america/rio_branco', 'america/rio_branco'],
  ])('config %p → %p', async (content, expected) => {
    ;(getConfigContent as jest.Mock).mockResolvedValueOnce(content)
    // C1 (onda TZ-1): sem JWT a zona é lida pela CONEXÃO da transação (q), com cache próprio
    tz.invalidateInstitutionZone()
    const conn = { query: jest.fn().mockResolvedValue([[{ zone: content }]]) }
    const z1 = await institutionZone(payload)
    const z2 = await institutionZoneFor('setes_x', 1, conn)
    expect(z1).toBe(expected)
    expect(z2).toBe(expected)
    expect(() => todayIn(z1)).not.toThrow()
  })
})

describe('compileCriteria — storage datetime nas 4 zonas', () => {
  const defs: SearchCriterion[] = [{ key: 'createdAt', kind: 'date', labelKey: 'x', expr: 'c.created_at', storage: 'datetime' }]
  const run = (v: unknown, zone: string) => compileCriteria(JSON.stringify({ createdAt: v }), defs, zone)

  it.each([
    ['America/Noronha',    '2026-12-31 02:00:00', '2027-01-01 02:00:00'],
    ['America/Sao_Paulo',  '2026-12-31 03:00:00', '2027-01-01 03:00:00'],
    ['America/Manaus',     '2026-12-31 04:00:00', '2027-01-01 04:00:00'],
    ['America/Rio_Branco', '2026-12-31 05:00:00', '2027-01-01 05:00:00'],
  ])('%s: virada de ano (31/12 inclusivo)', (zone, from, to) => {
    const c = run({ from: '2026-12-31', to: '2026-12-31' }, zone)
    expect(c.params).toEqual([from, to])
    expect(c.sql).toContain(`CONVERT_TZ(?, '+00:00', @@session.time_zone)`)
  })

  it('virada de mês bissexto (29/02/2028 → 01/03) em Manaus', () => {
    expect(run({ to: '2028-02-29' }, 'America/Manaus').params).toEqual(['2028-03-01 04:00:00'])
  })

  it('data impossível vira 422, não 500', () => {
    expect(() => run({ from: '2026-02-30' }, 'America/Sao_Paulo')).toThrow(expect.objectContaining({ statusCode: 422 }))
  })

  // MEDIUM (provado): `to: '9999-12-31'` passa por isValidIsoDate, nextDay devolve
  // '+010000-01' (toISOString de ano > 9999) e dayStartUtc lança RangeError
  // "Invalid time value" — não é HttpError → handleError responde 500 + crashlytics
  // em GET /api/customers?criteria={"createdAt":{"to":"9999-12-31"}} (D-BA1: nunca 500).
  it('MEDIUM: to = 9999-12-31 não pode lançar RangeError (500)', () => {
    let err: unknown = null
    try { run({ to: '9999-12-31' }, 'America/Sao_Paulo') } catch (e) { err = e }
    expect(err === null || (err as any).statusCode === 422).toBe(true)
  })

  it('evidência do MEDIUM: a cadeia nextDay → dayStartUtc', () => {
    expect(nextDay('9999-12-31')).toBe('+010000-01')
    expect(() => dayStartUtc(nextDay('9999-12-31'), 'America/Sao_Paulo')).toThrow(RangeError)
  })
})

describe('idempotência de transição (UTC × parede antiga) — falso positivo 3h', () => {
  const q = () => ({ query: jest.fn().mockResolvedValue([[{ n: 0 }]]) })

  it('hasRegistrationEvent casa dt UTC OU dt−3h (parede de SP)', async () => {
    const conn = q()
    await hasRegistrationEvent(conn as any, 'setes_x', 1, 10, 1, 'G' as any, '2026-09-30 18:00:00')
    expect(conn.query.mock.calls[0][1]).toEqual([1, 10, 1, 'G', '2026-09-30 18:00:00', '2026-09-30 15:00:00'])
  })

  it('hasTransmissionEvent idem', async () => {
    const conn = q()
    await hasTransmissionEvent(conn as any, 'setes_x', 1, 10, 1, 'A' as any, '2026-09-30 18:00:00')
    expect(conn.query.mock.calls[0][1]).toEqual([1, 10, 1, 'A', '2026-09-30 18:00:00', '2026-09-30 15:00:00'])
  })

  // LOW (analisado): a janela de transição é PERMANENTE no código — uma 2ª voz REAL
  // do mesmo kind, na mesma tentativa, exatamente 3h (ao segundo) depois de uma voz
  // já gravada em UTC é engolida como "já existe". Exige coincidência ao segundo e
  // repetição do MESMO kind na MESMA tentativa (kinds finais não repetem; voz só-data
  // vira múltiplo de 24h e nunca colide) — risco real desprezível, mas não há data de
  // corte que desligue o 2º casamento.
  it('DOCUMENTA: voz UTC 21:00 casa a voz UTC 18:00 já gravada (mesmo kind/tentativa)', async () => {
    const conn = q()
    await hasRegistrationEvent(conn as any, 'setes_x', 1, 10, 1, 'G' as any, '2026-09-30 21:00:00')
    expect(conn.query.mock.calls[0][1]).toContain('2026-09-30 18:00:00')
  })
})
