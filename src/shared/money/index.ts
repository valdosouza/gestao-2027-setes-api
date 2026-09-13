/**
 * Dinheiro em 2 casas — a MESMA regra do DECIMAL(…,2) do banco.
 *
 * Q-A27 (re-prova adversarial final do cancelamento de nota, 2026-09-09):
 * `Math.round(9.995 * 100) / 100` dá 9,99 em JS (9.995 é 9.99499999… em
 * binário) enquanto o banco recebe o literal "9.995" e grava 10,00 (half-up
 * sobre o decimal ESCRITO). Validar com uma regra e gravar com outra abriu
 * uma baixa com principal ZERO (juros 9,995 sobre 10 pagos → 201). Aqui o
 * arredondamento é feito sobre a representação decimal curta do double
 * (`toPrecision(15)` limpa o ruído binário) — 9,995 → 10,00 como o banco.
 *
 * Regra: o que a API VALIDA é o que ela GRAVA — normalize com `round2` antes
 * de comparar e passe o valor normalizado ao INSERT.
 */

/** Centavos inteiros (half-up sobre o decimal escrito). */
export function toCents(n: number | string | null | undefined): number {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v)) return 0
  return Math.round(Number((v * 100).toPrecision(15)))
}

/** Valor em 2 casas (mesma regra do DECIMAL(…,2)). */
export function round2(n: number | string | null | undefined): number {
  return toCents(n) / 100
}
