/// <reference types="jest" />
// TSString do XSD (`[!-ÿ]{1}[ -ÿ]{0,}[!-ÿ]{1}` — só U+0020–U+00FF): achado em PRODUÇÃO em 2026-10-10 — o cancelamento da NFS-e 706
// com o motivo "teste" levou o travessão (U+2014) do complemento automático e o fisco recusou o evento com 400 sem detalhe.
import { normalizeCancelMotive } from '@shared/invoice-transmission'
import { buildCancelEventXml, toTsString } from '../shared/tax-authority/dps-builder'

const TS_STRING = /^(?:[!-ÿ][ -ÿ]*[!-ÿ]|[!-ÿ])$/
const CHAVE = '4106902' + '2' + '2' + '12345678000199' + '0000000000123' + '2609' + '000000001' + '7'
const xMotivoOf = (xml: string) => xml.match(/<xMotivo>([^<]*)<\/xMotivo>/)![1]

describe('TSString do XSD — motivo do cancelamento e texto livre', () => {
  it('motivo curto ("teste") ganha o complemento com hífen ASCII e casa o padrão do XSD', () => {
    const m = normalizeCancelMotive('teste')
    expect(m).toBe('teste - Cancelamento solicitado pelo emissor')
    expect(TS_STRING.test(m)).toBe(true)
    const xml = buildCancelEventXml({ accessKey: CHAVE, dhEvento: '2026-10-10T17:30:00-03:00', cMotivo: '1', xMotivo: m, environment: 'P', verAplic: 'v', cnpjAutor: '12345678000199' })
    expect(TS_STRING.test(xMotivoOf(xml))).toBe(true)
  })

  it('tipografia vira ASCII e o que passa de U+00FF sai (emoji, separador Unicode); acento do português fica', () => {
    expect(toTsString('Serviço “mensal” – suporte… — ok \u{1F600} fim')).toBe('Serviço "mensal" - suporte... - ok  fim')
    for (const raw of ['erro — na emissão', '\u{1F600}'.repeat(16), 'a–b“c”'.repeat(3)]) {
      const m = normalizeCancelMotive(raw)
      expect([raw, TS_STRING.test(m) && m.length >= 15 && m.length <= 255]).toEqual([raw, true])
    }
  })
})
