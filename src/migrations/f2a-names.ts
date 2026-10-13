// Nomes da migration da F2a no `_migrations` — módulo SEM dependências (o runner e a conferência dos gatilhos importam daqui; nenhum ciclo).

/** O NOME da migration da F2a no `_migrations` (a nfse-api confere por nome — D-F110). */
export const F2A_PASSIVO_NAME = 'f2a_fiscal_passivo'

/**
 * D-F153 (= Q-F158 (c), Valdo 2026-10-13 — gate socrático do delta da Rodada 4, F2AR4-SOC-03): a LÁPIDE que o aborto deixa no
 * `_migrations` — a MESMA versão da migration com OUTRO nome. O código ANTIGO (sem o arquivo) sobe normalmente (o runner ignora versão
 * aplicada sem arquivo); o código NOVO (com o arquivo) RECUSA subir (versão aplicada com outro nome — PADROES §11 regra 14, com a
 * mensagem própria do `assertAppliedMatchFiles`): um restart acidental do código novo nunca re-congela calado. Voltar à F2a = ato
 * deliberado (`scripts/f2a-abort-before-cutover.ts … --retirar-lapide --vai`).
 */
export const F2A_TOMBSTONE_NAME = 'f2a_fiscal_passivo_abortada'
