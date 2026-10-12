/// <reference types="jest" />
// D-A36 (Valdo 2026-09-13: "contar pelo último evento"): o saldo devolvível de uma venda é
// DERIVADO (vendido − Σ devolvido) e "devolvido" conta só o que está VIGENTE — devolução cuja
// ordem morreu ou cuja NOTA foi cancelada sai da soma. A venda nunca é alterada.
import { CURRENT_RETURN_SQL } from '../shared/order-return'

describe('CURRENT_RETURN_SQL — devolução vigente', () => {
  const sql = CURRENT_RETURN_SQL('setes_setes', 'r')

  it('exige a ordem de ajuste VIVA', () => {
    expect(sql).toMatch(/tb_order adj[\s\S]*adj\.deleted = 'N'/)
  })

  it('exclui a devolução cuja NOTA tem o último evento C (cancelada) — o último evento vem da VIEW de política (D-F32, F2a A2)', () => {
    expect(sql).toMatch(/SELECT lv\.last_kind FROM `setes_setes`\.vw_invoice_life lv[\s\S]*lv\.tb_invoice_id = r\.tb_order_id[\s\S]*\), 'E'\) <> 'C'/)
    expect(sql).not.toMatch(/tb_invoice_event/)
  })

  it('devolução ABERTA (sem nota) continua contando — COALESCE cai em E', () => {
    expect(sql).toMatch(/COALESCE\(\(SELECT lv\.last_kind/)
  })

  it('respeita o alias recebido (a peça é reusada em duas consultas)', () => {
    expect(CURRENT_RETURN_SQL('setes_setes', 'x')).toMatch(/adj\.id = x\.tb_order_id/)
  })
})
