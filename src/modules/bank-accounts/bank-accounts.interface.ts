/**
 * Tipos do módulo bank-accounts — Contas Bancárias (Módulo Software House,
 * seção 5.6 do prompt FECHADO; Valdo 2026-07-19). tb_bank_account no
 * SCHEMA DO CLIENTE (PK id + tb_institution_id; id MAX+1 por institution)
 * apontando para o catálogo CENTRAL setes_central.tb_bank (DP2 —
 * referência FEBRABAN compartilhada, seed sql/17). Usada pelo movimento
 * financeiro (tb_financial_statement.tb_bank_account_id: 0 = Caixa,
 * > 0 = conta corrente) e pela conciliação futura (P4).
 * Espelho no app: apps/web/lib/app/modules/bank_accounts/.
 */

export interface BankAccountListRow {
  id:              number
  bankId:          number
  bankNumber:      string | null
  bankDescription: string | null
  agency:          string | null
  agencyDv:        string | null
  number:          string | null
  numberDv:        string | null
  manager:         string | null
  limitValue:      number | null
}

export interface BankAccountFull extends BankAccountListRow {
  dtOpening:  string | null
  phone:      string | null
  dtContract: string | null
}

export interface BankAccountInput {
  bankId:      number
  dtOpening?:  string | null
  agency:      string
  agencyDv?:   string | null
  number:      string
  numberDv?:   string | null
  phone?:      string | null
  manager?:    string | null
  limitValue?: number | null
  dtContract?: string | null
}

/** Lookup do catálogo central de bancos (form). */
export interface BankLookupRow {
  id:          number
  number:      string
  description: string | null
}
