/// <reference types="jest" />
// D-F43 — gate do delta da Rodada 6 (L2): o porte da correção dos caracteres de controle ficou PARCIAL no setes-api.
// O `text()` do builder já os removia, mas o `normalizeCancelMotive` media o piso de 15 ANTES disso: um motivo que só
// passava do piso por causa dos caracteres de controle encolhia depois e o builder lançava Error cru (500). Molde: o
// `normalizeCancelMotive` da nfse-api (`nfse-api/src/nfse/transmission.ts`).
import { normalizeCancelMotive } from '@shared/invoice-transmission'
import { buildCancelEventXml } from '../shared/tax-authority/dps-builder'

const CHAVE = '4106902' + '2' + '2' + '12345678000199' + '0000000000123' + '2609' + '000000001' + '7'
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

describe('normalizeCancelMotive × caracteres de controle (D-F43, L2)', () => {
  it('o controle sai ANTES do piso de 15: o motivo curto ganha o complemento e o builder NÃO lança', () => {
    const hostile = 'erro\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u000B\u000C\u000E\u000F'   // 4 letras + 12 controles
    const m = normalizeCancelMotive(hostile)
    expect(m).not.toMatch(CONTROL)
    expect(m).toBe('erro - Cancelamento solicitado pelo emissor')
    expect(() => buildCancelEventXml({ accessKey: CHAVE, dhEvento: '2026-09-21T11:00:00-03:00', cMotivo: '1', xMotivo: m,
      environment: 'H', verAplic: 'v', cnpjAutor: '12345678000199' })).not.toThrow()
  })

  it('motivo comum não muda', () => {
    expect(normalizeCancelMotive('Erro na emissão: valor do serviço incorreto')).toBe('Erro na emissão: valor do serviço incorreto')
  })
})
