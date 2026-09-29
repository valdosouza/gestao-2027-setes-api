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

/** opSimpNac da DPS (Onda 3 NFS-e, D-E3): 1 não optante · 2 MEI · 3 ME/EPP. */
export const SIMPLES_REGIME_CODES = ['1', '2', '3'] as const
/** regApTribSN do DPS (D-N19a, só para opSimpNac 3): 1 federais e municipal pelo SN · 2 ISSQN por fora · 3 tudo por fora. */
export const SIMPLES_ASSESSMENT_CODES = ['1', '2', '3'] as const
/** regEspTrib da DPS (D-E23; CRET do legado): 0 nenhum · 1 ato cooperado · 2 estimativa ·
 *  3 microempresa municipal · 4 notário/registrador · 5 profissional autônomo · 6 sociedade de profissionais. */
export const SPECIAL_TAX_REGIME_CODES = ['0', '1', '2', '3', '4', '5', '6'] as const

/**
 * D-N20 (MEDIUM-5 do gate): `tribISSQN` do DPS DERIVADO da exigibilidade do ISS
 * do EMITENTE (`iss_exigibilidade`, códigos do legado): 01 exigível → 1
 * tributável · 05 imunidade → 2 imune · 04 exportação → 3 · 02 não incidência
 * → 4; demais (suspensa por decisão judicial/processo administrativo, isenção)
 * e NULL → 1 (o fisco não tem código para elas no tribISSQN; a alíquota/retenção
 * continuam falando). Uma função só, consumida pelas DUAS portas (billing e OS).
 */
export type IssLiability = '1' | '2' | '3' | '4'
export function liabilityFromExigibilidade(code: string | null | undefined): IssLiability {
  switch (String(code ?? '').padStart(2, '0')) {
    case '05': return '2'
    case '04': return '3'
    case '02': return '4'
    default:   return '1'
  }
}

/** CRT = 1º caractere do tax_regime ("1 - Simples Nacional" → '1'). */
export function parseCrt(taxRegime: string | null | undefined): string | null {
  const first = (taxRegime ?? '').trim().charAt(0)
  return ['1', '2', '3'].includes(first) ? first : null
}

export interface EntityTaxInput {
  consumer?:               SN | null
  taxRegime?:              string | null
  /** Fatos do EMITENTE (só fazem sentido quando entity = institution — Onda 3). */
  simplesRegime?:          string | null
  /** regApTribSN (D-N19a) — só faz sentido com simplesRegime '3'; NULL = dentro do sublimite (omitido no DPS). */
  simplesAssessment?:      string | null
  specialTaxRegime?:       string | null
  cnae?:                   string | null
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
  simplesRegime:          string | null
  simplesAssessment:      string | null
  specialTaxRegime:       string | null
  cnae:                   string | null
  byPassSt:               SN | null
  indIeDest:              string | null
  issExigibilidade:       string | null
  issProcessNr:           string | null
  issRetido:              SN | null
  issIndIncFiscal:        SN | null
  autoSendInvoice:        SN | null
  autoSendInvoiceJustXml: SN | null
}
