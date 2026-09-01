/**
 * Tipos de TRIBUTAÇÃO por relação comercial — tb_entity_tax no SCHEMA DO
 * CLIENTE, PK (id, tb_institution_id). Fase 3 Rodada 4 (decisões 14–17):
 * QUALQUER entidade pode precisar de tributação para receber notas (não só
 * clientes) — por isso é peça compartilhada, consumida pelos módulos de papel
 * (customers hoje; providers/collaborators no futuro) e pelos endpoints
 * avulsos GET/PUT /api/entities/:id/tax.
 *
 * Peça independente (SRP): NUNCA importa a composição da cadeia — o vínculo
 * é o entityId + institutionId recebidos por parâmetro.
 */

export type SN = 'S' | 'N'

/** Códigos de exigibilidade do ISS — legado Delphi/NFSe (decisão 15). */
export const ISS_EXIGIBILIDADE_CODES = ['01', '02', '03', '04', '05', '06', '07'] as const

/** Regimes tributários canônicos (decisão 15) — grava o RÓTULO completo;
 *  o código NFe (CRT) é o 1º caractere (Lucro Real e Presumido = mesmo 3). */
export const TAX_REGIMES = [
  '1 - Simples Nacional',
  '2 - Simples Nacional - excesso de sublimite de receita bruta',
  '3 - Regime Normal - Lucro Real',
  '3 - Regime Normal - Lucro Presumido',
] as const

/** Indicador de IE do destinatário (NFe). */
export const IND_IE_DEST_CODES = ['1', '2', '9'] as const

/** CRT = 1º caractere do tax_regime ("1 - Simples Nacional" → '1'). */
export function parseCrt(taxRegime: string | null | undefined): string | null {
  const first = (taxRegime ?? '').trim().charAt(0)
  return ['1', '2', '3'].includes(first) ? first : null
}

export interface EntityTaxInput {
  consumer?:               SN | null
  taxRegime?:              string | null
  byPassSt?:               SN | null
  indIeDest?:              string | null
  issExigibilidade?:       string | null
  issProcessNr?:           string | null
  issRetido?:              SN | null
  issIndIncFiscal?:        SN | null
  autoSendInvoice?:        SN | null
  autoSendInvoiceJustXml?: SN | null
}

export interface EntityTaxRow {
  consumer:               SN | null
  taxRegime:              string | null
  byPassSt:               SN | null
  indIeDest:              string | null
  issExigibilidade:       string | null
  issProcessNr:           string | null
  issRetido:              SN | null
  issIndIncFiscal:        SN | null
  autoSendInvoice:        SN | null
  autoSendInvoiceJustXml: SN | null
}
