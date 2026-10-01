/// <reference types="jest" />
// Fuso do estabelecimento (Q-BA14/Q-TZ2 — prompt_pesquisa_avancada.md §9.3/§10):
// a hora de emissão da NFS-e é a da ZONA do estabelecimento, nunca a do processo.
import { nowIsoIn, todayIn, toZoneWall, toUtcDb, withZoneWall } from '../shared/time-zone'
import { formatDateTimeTz } from '../shared/tax-authority/dps-builder'

const instant = new Date('2026-10-01T01:00:30.987Z')   // 30/09 22:00:30 em Brasília

describe('nowIsoIn — dhEmi/dhEvento na zona (Q-TZ2)', () => {
  it.each([
    ['America/Sao_Paulo',  '2026-09-30T22:00:30-03:00'],
    ['America/Manaus',     '2026-09-30T21:00:30-04:00'],
    ['America/Noronha',    '2026-09-30T23:00:30-02:00'],
    ['America/Rio_Branco', '2026-09-30T20:00:30-05:00'],
    ['UTC',                '2026-10-01T01:00:30+00:00'],
  ])('%s', (zone, expected) => {
    expect(nowIsoIn(zone, instant)).toBe(expected)
  })

  it('independe do fuso do PROCESSO: o mesmo instante dá o mesmo dhEmi', () => {
    // o valor depende só do instante e da zona — e passa intacto pelo normalizador do XSD
    const iso = nowIsoIn('America/Sao_Paulo', instant)
    expect(formatDateTimeTz(iso)).toBe('2026-09-30T22:00:30-03:00')
    expect(iso.slice(0, 10)).toBe(todayIn('America/Sao_Paulo', instant))
  })

  it('horário de verão histórico de SP (2019-01-15, -02:00)', () => {
    expect(nowIsoIn('America/Sao_Paulo', new Date('2019-01-15T12:00:00Z'))).toBe('2019-01-15T10:00:00-02:00')
  })
})

describe('Q-TZ1 — banco em UTC, apresentação na zona', () => {
  it('toZoneWall: instante UTC do banco → hora de parede da zona', () => {
    expect(toZoneWall('2026-10-01 01:00:30', 'America/Sao_Paulo')).toBe('2026-09-30 22:00:30')
    expect(toZoneWall('2026-10-01 01:00:30', 'America/Manaus')).toBe('2026-09-30 21:00:30')
    expect(toZoneWall(new Date('2026-10-01T01:00:30Z'), 'America/Sao_Paulo')).toBe('2026-09-30 22:00:30')
    expect(toZoneWall(null, 'America/Sao_Paulo')).toBeNull()
    expect(toZoneWall('lixo', 'America/Sao_Paulo')).toBeNull()
  })

  it('toUtcDb: voz com offset, com Z, sem offset (hora da zona) e só a data', () => {
    expect(toUtcDb('2026-09-30T22:00:30-03:00')).toBe('2026-10-01 01:00:30')
    expect(toUtcDb('2026-09-30T22:00:30.999Z')).toBe('2026-09-30 22:00:30')
    expect(toUtcDb('2026-09-30 22:00:30', 'America/Sao_Paulo')).toBe('2026-10-01 01:00:30')
    expect(toUtcDb('2026-09-30', 'America/Manaus')).toBe('2026-09-30 04:00:00')
    expect(toUtcDb('2026-09-30T22:00:30-0300')).toBe('2026-10-01 01:00:30')
    expect(toUtcDb('lixo')).toBeNull()
  })

  it('ida e volta: o que a tela vê é a hora que o terceiro disse', () => {
    const stored = toUtcDb('2026-09-21T10:15:30-03:00')
    expect(toZoneWall(stored, 'America/Sao_Paulo')).toBe('2026-09-21 10:15:30')
  })

  it('withZoneWall converte só os campos pedidos, sem mutar a linha', () => {
    const row = { id: 1, createdAt: '2026-10-01 01:00:00', note: '2026-10-01 01:00:00', dh: null as string | null }
    const out = withZoneWall(row, ['createdAt', 'dh'], 'America/Sao_Paulo')
    expect(out).toEqual({ id: 1, createdAt: '2026-09-30 22:00:00', note: '2026-10-01 01:00:00', dh: null })
    expect(row.createdAt).toBe('2026-10-01 01:00:00')
  })
})
