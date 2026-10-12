/// <reference types="jest" />
// D-F106 (= Q-F112 (b), Valdo 2026-10-11) no setes-api — o caminho de PRODUÇÃO da NFS-e até a F2a (S6 do gate socrático da Rodada 22:
// o setes-api não tinha testemunha própria). O escritor da voz aceita só a lista POSITIVA da família NFS-e (A/R/C/K/F/N): o TIPO recusa
// S/P/D e o vocabulário comum (testemunhas de COMPILAÇÃO — o ts-jest confere: um `@ts-expect-error` sem erro QUEBRA este arquivo); o FUNIL
// recusa em EXECUÇÃO o que o tipo não vê (cast, spread, JSON — R22-03) ANTES de qualquer query; o `OUTCOME_KIND` é congelado (R22-02).
// Puro: conexão FALSA, nenhum banco. Esta composição morre na F2a — este teste morre com ela.
import type { PoolConnection } from 'mysql2/promise'
import {
  insertTransmissionEvent, SERVICE_VOICE_WRITE_KINDS, TransmissionEventInput, ServiceVoiceWriteKind,
} from '../shared/invoice-transmission/transmission.repository'
import { OUTCOME_KIND } from '../shared/invoice-transmission/branches/service'
import type { TransmissionEventKind } from '../shared/invoice-transmission/transmission-kinds'

/** Conexão FALSA: o escritor REAL roda inteiro (MAX+1 e INSERT) sem banco; guarda o kind de cada INSERT. */
function fakeConn() {
  const kinds: unknown[] = []
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/MAX\(event\)/.test(sql)) return [[{ next: 1 }]]
    if (/INSERT INTO\s+`[^`]+`\.tb_invoice_service_transmission_event/.test(sql)) kinds.push(params[4])
    return [{ affectedRows: 1, insertId: 1 }]
  })
  return { conn: { query } as unknown as PoolConnection, query, kinds }
}

describe('D-F106 no setes-api — o escritor da voz da NFS-e', () => {
  it('a lista de escrita da família é EXATAMENTE A/R/C/K/F/N (S fora — D-F102/D-F105; P/D da NF-e fora)', () => {
    expect([...SERVICE_VOICE_WRITE_KINDS]).toEqual(['A', 'R', 'C', 'K', 'F', 'N'])
  })

  it('o TIPO do escritor REAL recusa S, P, D e o vocabulário comum — testemunhas presas à CHAMADA (função que não roda)', () => {
    const SENT: TransmissionEventKind = 'S'
    const neverRun = async (conn: PoolConnection) => {
      // @ts-expect-error — D-F106: o escritor REAL recusa S
      await insertTransmissionEvent(conn, 'setes_x', 1, 1, 1, null, { kind: 'S', source: 'P' })
      // @ts-expect-error — D-F106: P (NF-e, em processamento) não é da família NFS-e
      await insertTransmissionEvent(conn, 'setes_x', 1, 1, 1, null, { kind: 'P', source: 'Q' })
      // @ts-expect-error — D-F106: D (NF-e, denegada) não é da família NFS-e
      await insertTransmissionEvent(conn, 'setes_x', 1, 1, 1, null, { kind: 'D', source: 'Q' })
      // @ts-expect-error — D-F106: o vocabulário COMUM não cabe no do escritor
      await insertTransmissionEvent(conn, 'setes_x', 1, 1, 1, null, { kind: SENT, source: 'P' })
      await insertTransmissionEvent(conn, 'setes_x', 1, 1, 1, null, { kind: 'F', source: 'P' })   // a família segue aceita
    }
    // @ts-expect-error — o mapa que grava na voz é Readonly (R22-02)
    const assign = () => { OUTCOME_KIND.local = 'F' }
    const family: ServiceVoiceWriteKind[] = ['A', 'R', 'C', 'K', 'F', 'N']
    expect([typeof neverRun, typeof assign, family.length]).toEqual(['function', 'function', 6])
  })

  it('o FUNIL recusa em EXECUÇÃO S, P, D, "s" minúsculo (que a colação _ci leria como S — D-F103), vazio e ausente — ANTES de qualquer query', async () => {
    const { conn, query, kinds } = fakeConn()
    for (const k of ['S', 'P', 'D', 's', 'a', '', undefined, null]) {
      const ev = { kind: k, source: 'P' } as unknown as TransmissionEventInput
      await expect(insertTransmissionEvent(conn, 'setes_x', 1, 6200, 1, 7, ev)).rejects.toThrow(/D-F106: kind fora do vocabulário de escrita da NFS-e/)
    }
    // spread POSTERIOR de uma bolsa larga compila sem cast — o funil pega (R22-01)
    const extra: Record<string, unknown> = JSON.parse('{"kind":"S"}')
    await expect(insertTransmissionEvent(conn, 'setes_x', 1, 6200, 1, 7, { kind: 'F', source: 'P', ...extra })).rejects.toThrow(/D-F106/)
    expect(query).not.toHaveBeenCalled()
    expect(kinds).toEqual([])
  })

  it('o funil deixa passar os seis da família (a escrita legítima não quebrou)', async () => {
    const { conn, kinds } = fakeConn()
    for (const k of SERVICE_VOICE_WRITE_KINDS) await insertTransmissionEvent(conn, 'setes_x', 1, 6200, 1, 7, { kind: k, source: 'P' })
    expect(kinds).toEqual(['A', 'R', 'C', 'K', 'F', 'N'])
  })

  it('o `OUTCOME_KIND` é CONGELADO em execução — `Object.assign` lança, `Reflect.set` não muda nada (R22-02)', () => {
    expect(Object.isFrozen(OUTCOME_KIND)).toBe(true)
    expect(() => Object.assign(OUTCOME_KIND, { local: 'S' })).toThrow(TypeError)
    expect(Reflect.set(OUTCOME_KIND, 'auth_failed', 'S')).toBe(false)
    expect(OUTCOME_KIND).toEqual({ rejected: 'R', auth_failed: 'F', local: 'F' })
  })
})
