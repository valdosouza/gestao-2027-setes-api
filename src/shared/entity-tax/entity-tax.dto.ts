import { z } from 'zod'
import {
  ISS_EXIGIBILIDADE_CODES, TAX_REGIMES, IND_IE_DEST_CODES,
} from './entity-tax.types'

/**
 * Zod da TRIBUTAÇÃO (tb_entity_tax) — peça independente (SRP).
 * UI (aba Tributação — instruções do Valdo, 2026-07-16):
 * radiobox S/N (consumer, issRetido, issIndIncFiscal), checkbox S/N
 * (byPassSt, autoSendInvoice, autoSendInvoiceJustXml), dropdowns canônicos
 * (taxRegime, indIeDest 1/2/9, issExigibilidade 01..07).
 */

const sn = z.enum(['S', 'N'])

export const entityTaxBody = z.object({
  consumer:               sn.nullable().optional(),
  taxRegime:              z.enum(TAX_REGIMES).nullable().optional(),
  byPassSt:               sn.nullable().optional(),
  indIeDest:              z.enum(IND_IE_DEST_CODES).nullable().optional(),
  issExigibilidade:       z.enum(ISS_EXIGIBILIDADE_CODES).nullable().optional(),
  issProcessNr:           z.string().max(25).nullable().optional(),
  issRetido:              sn.nullable().optional(),
  issIndIncFiscal:        sn.nullable().optional(),
  autoSendInvoice:        sn.nullable().optional(),
  autoSendInvoiceJustXml: sn.nullable().optional(),
})

export type EntityTaxDto = z.infer<typeof entityTaxBody>
