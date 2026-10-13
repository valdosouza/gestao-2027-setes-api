// Nomes da migration da F2a no `_migrations` — módulo SEM dependências (o runner e a conferência dos gatilhos importam daqui; nenhum ciclo).

/** O NOME da migration da F2a no `_migrations` (a nfse-api confere por nome — D-F110). */
export const F2A_PASSIVO_NAME = 'f2a_fiscal_passivo'

/**
 * D-F153 (= Q-F158 (c), Valdo 2026-10-13 — gate socrático do delta da Rodada 4, F2AR4-SOC-03): a LÁPIDE que o aborto deixa no
 * `_migrations` — a linha com OUTRO nome. O código ANTIGO (sem o arquivo) sobe normalmente (o runner ignora versão aplicada sem arquivo);
 * o código NOVO (com o arquivo) RECUSA subir — pelo NOME (R5-SOC-03/R5-ADV-01: o número muda num rebase), com a mensagem própria do
 * `assertAppliedMatchFiles`: um restart acidental do código novo nunca re-congela calado. Voltar à F2a = ato deliberado
 * (`scripts/f2a-abort-before-cutover.ts … --retirar-lapide --vai`).
 */
export const F2A_TOMBSTONE_NAME = 'f2a_fiscal_passivo_abortada'

/**
 * D-F162 (= Q-F170 (a), Valdo 2026-10-13 — gate adversarial do delta da Rodada 5, R5-ADV-01/02): a lápide tem versão SENTINELA, nunca o
 * número da migration. Com o número (069) a lápide o OCUPAVA no `_migrations` de produção: a próxima migration do `main` com ele derrubava
 * o boot do código ANTIGO — justo o que roda depois de um aborto — com a frase genérica de número repetido (e o `tsx watch` = produção fora
 * ao salvar). Cabe no `VARCHAR(10)` do `_migrations`; o runner (do `main` e da F2a) ignora versão aplicada sem arquivo e não ordena por
 * número para decidir (conferido). Uma por schema (a versão é UNIQUE).
 */
export const F2A_TOMBSTONE_VERSION = 'F2A-ABORT'
