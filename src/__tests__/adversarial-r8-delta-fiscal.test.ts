/// <reference types="jest" />
// GATE ADVERSARIAL do delta das APIs fiscais (sessão 2026-10-10) — lado setes-api, SÓ unit/mocks (nenhuma escrita no
// `setes_setes` real). Alvos:
//  - D-F56 (`lockIssuerHistory` + `saveIssuer`/`removeIssuer`): a habilitação SE com numeração emitida não é REVIVIDA nem
//    EXCLUÍDA pelo ERP — só o ato da virada (nfse-api `scripts/cutover-erp.ts`) a aposenta.
//  - L2 (`normalizeCancelMotive`): Unicode e tamanhos-limite no motivo do cancelamento (o piso de 15 contado depois de
//    limpar o controle).
// Achados (os `it.failing` fixam o estado atual — a correção/decisão é do Valdo):
//  - [MEDIUM ADV-R8-01 → Q-F65] o ato da virada aposenta a SE com `deleted='S'` SEM olhar o contador: numa institution que
//    vira com `dps_last_number = 0` (cliente novo do dual-run que configurou a SE no ERP e nunca emitiu), a linha aposentada
//    é indistinguível de "SE excluída sem história" e o PUT da aba "Emissor fiscal" a REVIVE — o setes-api volta a cunhar
//    nDPS a partir de 0 na MESMA série que a nfse-api já cunha (R2-2 / M1 reaberto para quem virou sem numeração).
//  - [LOW ADV-R8-07] xMotivo leva ao XML assinado caractere que não é XML (U+FFFE/U+FFFF), surrogate solto (inclusive o
//    criado pelo corte em 255 no meio de um emoji) e invisíveis (U+200B) que contam para o piso de 15 — não há 500, o
//    fisco recusa (409) ou aceita um motivo "vazio".
import pool from '../shared/db/connection'
import { saveIssuer, removeIssuer } from '../modules/establishment/establishment.issuer.service'
import { lockIssuerHistory } from '../shared/fiscal-issuer'
import { normalizeCancelMotive } from '@shared/invoice-transmission'
import { buildCancelEventXml } from '../shared/tax-authority/dps-builder'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

const S = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }

const historySql = (sql: string) => /dps_last_number AS dpsLastNumber/.test(sql)
const rowSql = (sql: string) => /tb_establishment_issuer/.test(sql) && /^\s*SELECT/.test(sql) && !historySql(sql)

/** Banco FALSO de UMA linha da habilitação (o estado que o ato da virada deixa: deleted='S', contador intacto). */
function erpRow(initial: { model: string; deleted: 'S' | 'N'; dpsLastNumber: number } | null) {
  let row = initial ? { ...initial } : null
  const calls: string[] = []
  conn.query.mockImplementation(async (sql: string) => {
    calls.push(sql)
    if (historySql(sql)) return [row ? [{ deleted: row.deleted, dpsLastNumber: row.dpsLastNumber }] : []]
    if (rowSql(sql)) {
      const alive = row && row.deleted === 'N' && (!/deleted = 'N'/.test(sql) || row.deleted === 'N')
      return [alive ? [{ institutionId: 1, model: row!.model, environment: 'P', serie: '1', userId: 7 }] : []]
    }
    if (/tb_invoice_service_transmission/.test(sql)) return [[{ n: 0 }]]
    if (/^\s*INSERT INTO/.test(sql)) { row = row ? { ...row, deleted: 'N' } : { model: 'SE', deleted: 'N', dpsLastNumber: 0 }; return [{ affectedRows: 1 }] }
    if (/SET deleted = 'S'/.test(sql)) { if (row) row.deleted = 'S'; return [{ affectedRows: 1 }] }
    return [{ affectedRows: 1 }]
  })
  return { calls, now: () => row }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  ;((pool as any).query as jest.Mock).mockResolvedValue([[]])
})

describe('D-F56 — a SE aposentada pelo ATO não volta pelo ERP', () => {
  it('sem achado: `lockIssuerHistory` é UMA leitura pela PK (institution × modelo) com FOR UPDATE — viva OU excluída (sem filtro de deleted)', async () => {
    const c = { query: jest.fn(async () => [[{ deleted: 'S', dpsLastNumber: '12' }]]) } as any
    expect(await lockIssuerHistory(c, 'setes_setes', 1, 'SE')).toEqual({ deleted: true, dpsLastNumber: 12 })
    const [sql, params] = c.query.mock.calls[0]
    expect(sql).toMatch(/FROM `setes_setes`\.tb_establishment_issuer\s+WHERE tb_institution_id = \? AND model = \? FOR UPDATE/)
    expect(sql).not.toMatch(/deleted\s*=/)                                       // a história conta a linha excluída
    expect(params).toEqual([1, 'SE'])
    // contador NULL/lixo vira 0 (não NaN): a guarda `> 0` não pode ser contornada por um contador ilegível… e é por isso
    // que o contador 0 é o ponto cego do ADV-R8-01 abaixo
    c.query.mockResolvedValueOnce([[{ deleted: 'S', dpsLastNumber: null }]])
    expect(await lockIssuerHistory(c, 'setes_setes', 1, 'SE')).toEqual({ deleted: true, dpsLastNumber: 0 })
  })

  it('sem achado: o PUT e o DELETE da SE travam a HISTÓRIA como 1ª instrução da transação (a MESMA linha que o ato trava 1º — sem ABBA)', async () => {
    erpRow({ model: 'SE', deleted: 'N', dpsLastNumber: 3 })
    await saveIssuer('SE', { environment: 'P', serie: '1' }, S)
    expect(historySql(conn.query.mock.calls[0][0])).toBe(true)
    jest.clearAllMocks(); ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    erpRow({ model: 'SE', deleted: 'N', dpsLastNumber: 3 })
    await expect(removeIssuer('SE', S)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_CUTOVER_ONLY' })
    expect(historySql(conn.query.mock.calls[0][0])).toBe(true)
  })

  it('sem achado: aposentada COM numeração (estado do ato) → PUT 409 FISCAL_ISSUER_RETIRED e nada gravado; DELETE → 404 (já não está viva)', async () => {
    const db = erpRow({ model: 'SE', deleted: 'S', dpsLastNumber: 3 })        // o dev: SE da Setes com dps_last_number 3
    await expect(saveIssuer('SE', { environment: 'P', serie: '1' }, S)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_RETIRED' })
    expect(db.calls.some(s => /INSERT INTO/.test(s))).toBe(false)
    expect(db.now()).toEqual({ model: 'SE', deleted: 'S', dpsLastNumber: 3 })
    for (const env of ['H', 'P'] as const) {                                    // nenhum corpo escapa (ambiente/série)
      await expect(saveIssuer('SE', { environment: env, serie: '49999' }, S)).rejects.toMatchObject({ code: 'FISCAL_ISSUER_RETIRED' })
    }
    await expect(removeIssuer('SE', S)).rejects.toMatchObject({ statusCode: 404, code: 'FISCAL_ISSUER_MISSING' })
  })

  it('sem achado: o PUT/DELETE do modelo 55 NÃO toca a linha SE (a guarda e os comandos são do modelo da URL)', async () => {
    const db = erpRow({ model: '55', deleted: 'N', dpsLastNumber: 0 })
    await saveIssuer('55', { environment: 'P', serie: '3' }, S)
    await removeIssuer('55', S)
    const writes = db.calls.filter(s => /^\s*(INSERT|UPDATE)/.test(s))
    expect(writes.length).toBeGreaterThan(0)
    expect(db.calls.some(historySql)).toBe(false)
    // todo comando de escrita é parametrizado pelo modelo (nenhum UPDATE "da institution inteira")
    for (const w of writes) expect(w).toMatch(/model/)
  })

  // ---------------------------------------------------------------------------------------------------------------
  // ADV-R8-01: o estado que o ATO deixa numa institution que virou SEM numeração emitida (contador 0) é idêntico ao de
  // "SE excluída sem história" — o teste de fiscal-issuer.test.ts fixa que essa linha REVIVE (implantação). O setes-api
  // não lê o fato da virada (D-F44: "fecha sem mudar código"), então não tem como distinguir. Depois do revive, o
  // `nextDpsNumber` do setes-api cunha 1, 2, 3… — os MESMOS nDPS que a nfse-api cunhou a partir do contador copiado (0) na
  // MESMA série (a D-F44 exige série '1' no ato): mesmo Id de DPS (cMun+CNPJ+série+nDPS) para notas DIFERENTES.
  // ---------------------------------------------------------------------------------------------------------------
  it('[MEDIUM ADV-R8-01 → D-F58 — CORRIGIDO] a SE aposentada pelo ATO da virada não revive pelo ERP MESMO com o contador 0 (nada gravado)', async () => {
    const db = erpRow({ model: 'SE', deleted: 'S', dpsLastNumber: 0 })
    await expect(saveIssuer('SE', { environment: 'P', serie: '1' }, S)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_RETIRED' })
    expect(db.calls.some(s => /INSERT INTO/.test(s))).toBe(false)
    expect(db.now()).toEqual({ model: 'SE', deleted: 'S', dpsLastNumber: 0 })
  })
})

describe('L2 — normalizeCancelMotive × Unicode e tamanhos-limite (porte D-F43)', () => {
  const CHAVE = '4106902' + '2' + '2' + '12345678000199' + '0000000000123' + '2609' + '000000001' + '7'
  const build = (xMotivo: string) => buildCancelEventXml({ accessKey: CHAVE, dhEvento: '2026-10-10T11:00:00-03:00', cMotivo: '1', xMotivo,
    environment: 'H', verAplic: 'v', cnpjAutor: '12345678000199' })
  const HOSTILE: Record<string, string> = {
    'U+2028/U+2029': 'erro  '.repeat(5), 'BOM': '﻿'.repeat(20), 'zero-width': '​'.repeat(20),
    'NEL/C1': '\u0085\u0080\u009F'.repeat(7), 'surrogate alto solto': '\uD800'.repeat(20), 'surrogate baixo solto': '\uDC00'.repeat(20),
    'U+FFFF': '￿'.repeat(20), 'U+FFFE': '￾'.repeat(20), 'emoji no corte': 'a'.repeat(254) + '\u{1F600}',
    '254': 'b'.repeat(254), '255': 'c'.repeat(255), '256': 'd'.repeat(256), '255+controle': '\u0001' + 'e'.repeat(255),
    'só controle': '\u0001\u0002\u0003'.repeat(10), 'só espaço': ' \t\r\n'.repeat(10), 'vazio': '', 'XML': '&<>"\''.repeat(4),
  }

  it('sem achado: nenhum motivo hostil faz o builder lançar (nada de 500) e o tamanho fica sempre em 15–255', () => {
    for (const [name, raw] of Object.entries(HOSTILE)) {
      const m = normalizeCancelMotive(raw)
      expect([name, m.length >= 15 && m.length <= 255]).toEqual([name, true])
      let thrown: string | null = null
      try { build(m) } catch (e: any) { thrown = String(e?.message) }
      expect([name, thrown]).toEqual([name, null])
    }
    expect(normalizeCancelMotive('d'.repeat(256))).toHaveLength(255)
    expect(normalizeCancelMotive('\u0001' + 'e'.repeat(255))).toBe('e'.repeat(255))
    expect(normalizeCancelMotive(' \t\r\n'.repeat(10))).toBe('Cancelamento solicitado pelo emissor')
  })

  // XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF] — surrogate solto não é caractere
  const NOT_XML_OR_LONE = /[￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  it('[LOW ADV-R8-07 — CORRIGIDO] o xMotivo que vai assinado ao fisco não leva não-caractere XML nem surrogate solto (inclusive o do corte em 255 no meio de um emoji) e o piso de 15 não é cumprido por invisíveis', () => {
    for (const name of ['U+FFFF', 'U+FFFE', 'surrogate alto solto', 'surrogate baixo solto', 'emoji no corte']) {
      expect([name, NOT_XML_OR_LONE.test(normalizeCancelMotive(HOSTILE[name]))]).toEqual([name, false])
    }
    expect(normalizeCancelMotive(HOSTILE['zero-width']).replace(/[​-‍⁠]/g, '').length).toBeGreaterThanOrEqual(15)
  })
})
