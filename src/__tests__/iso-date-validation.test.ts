/// <reference types="jest" />
// Gate adversarial da Onda 1 (achado 3): `dtExpiration: "2026-13-45"` passava
// pelo regex de formato, o MariaDB sem strict mode gravava '0000-00-00' no
// TÍTULO e o boleto automático — que é IMUTÁVEL por decisão — nascia com
// vencimento zerado. Formato nunca foi prova de existência.
import { isValidIsoDate } from '../shared/validation'
import {
  invoiceDto, batchInvoiceDto, orderItemDto,
} from '../modules/service-orders/service-orders.dto'
import { contractDto } from '../modules/contracts/contracts.dto'
import { issueBankSlipDto, settleBankSlipDto } from '../modules/bank-slips/bank-slips.dto'
import { settleBatchDto } from '../modules/settlements/settlements.dto'

describe('isValidIsoDate', () => {
  it('aceita data que EXISTE', () => {
    for (const d of ['2026-09-13', '2024-02-29', '2026-01-01', '2026-12-31']) {
      expect(isValidIsoDate(d)).toBe(true)
    }
  })
  it('recusa data com formato certo e calendário errado', () => {
    for (const d of ['2026-13-45', '2026-02-30', '2025-02-29', '2026-00-10', '2026-04-31']) {
      expect(isValidIsoDate(d)).toBe(false)
    }
  })
  it('recusa formato diferente', () => {
    for (const d of ['13/09/2026', '2026-9-13', '', '2026-09-13T00:00', 'ontem']) {
      expect(isValidIsoDate(d)).toBe(false)
    }
  })
})

describe('DTOs que geram TÍTULO não aceitam data inexistente', () => {
  const base = { paymentTypeId: 6, parcels: 1 }

  it('faturamento avulso da OS', () => {
    expect(invoiceDto.safeParse({ ...base, dtExpiration: '2026-13-45' }).success).toBe(false)
    expect(invoiceDto.safeParse({ ...base, dtExpiration: '2026-02-30' }).success).toBe(false)
    expect(invoiceDto.safeParse({ ...base, dtExpiration: '2026-10-05' }).success).toBe(true)
  })

  it('LOTE — a data ruim contaminaria as 200 ordens de uma vez', () => {
    const lote = { ...base, orderIds: [1, 2, 3] }
    expect(batchInvoiceDto.safeParse({ ...lote, dtExpiration: '2026-13-45' }).success).toBe(false)
    expect(batchInvoiceDto.safeParse({ ...lote, dtExpiration: '2026-10-05' }).success).toBe(true)
  })

  it('contrato (dtStart/dtEnd alimentam a competência da rotina mensal)', () => {
    const c = { customerId: 1, paymentDay: 5, active: 'S', items: [{ productId: 1, value: 10 }] }
    expect(contractDto.safeParse({ ...c, dtStart: '2026-02-30' }).success).toBe(false)
    expect(contractDto.safeParse({ ...c, dtStart: '2026-09-01', dtEnd: '2026-13-01' }).success).toBe(false)
    expect(contractDto.safeParse({ ...c, dtStart: '2026-09-01', dtEnd: null }).success).toBe(true)
  })
})

// Re-score socratico da Onda 1: corrigir a PORTA do ataque nao fecha a CLASSE.
// O dado sujo mora no mesmo lugar (titulo, boleto imutavel, cheque, baixa), e
// todo DTO que grava data passou a usar a mesma peca.
describe('a classe inteira: DTOs que gravam data em artefato imutável', () => {
  it('emissão de boleto recusa data inexistente', () => {
    const base = { agreementId: 1, titles: [{ orderId: 1, parcel: 1 }] }
    expect(issueBankSlipDto.safeParse({ ...base, dtExpiration: '2026-02-30' }).success).toBe(false)
    expect(issueBankSlipDto.safeParse({ ...base, dtExpiration: '2026-13-45' }).success).toBe(false)
  })

  it('liquidação de boleto recusa data inexistente', () => {
    expect(settleBankSlipDto.safeParse({ dtPayment: '2026-13-01', paidValue: 10 }).success).toBe(false)
  })

  it('baixa de título recusa data inexistente (e aceita a válida)', () => {
    const base = {
      titles: [{ orderId: 1, parcel: 1, paidValue: 10 }],
      bankAccountId: 0,
    }
    expect(settleBatchDto.safeParse({ ...base, dtPayment: '2025-02-29' }).success).toBe(false)
    expect(settleBatchDto.safeParse({ ...base, dtPayment: '2024-02-29' }).success).toBe(true)
  })
})

// Mesma regra da casa, outra classe de dado: o que valida tem que ser o que
// grava (Q-A27 / 02-VALIDACAO.md). Gate adversarial da Onda 1, MEDIUM-2 e 3.
describe('item da OS: o DTO respeita o DECIMAL do banco', () => {
  const base = { productId: 1, quantity: 1 }

  it('valor acima do DECIMAL(10,6) é RECUSADO, não truncado em silêncio', () => {
    // antes: 1e12 voltava 201 e o banco gravava 9999.999999 — a nota nascia
    // com total diferente do enviado
    expect(orderItemDto.safeParse({ ...base, unitValue: 1e12 }).success).toBe(false)
    expect(orderItemDto.safeParse({ ...base, unitValue: 10000 }).success).toBe(false)
    expect(orderItemDto.safeParse({ ...base, unitValue: 9999.999999 }).success).toBe(true)
  })

  it('quantidade acima do DECIMAL(10,4) é recusada', () => {
    expect(orderItemDto.safeParse({ ...base, quantity: 1e9, unitValue: 1 }).success).toBe(false)
    expect(orderItemDto.safeParse({ ...base, quantity: 999999.9999, unitValue: 1 }).success).toBe(true)
  })
})
