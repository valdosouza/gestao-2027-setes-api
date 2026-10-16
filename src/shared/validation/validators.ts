/**
 * Validadores COMPARTILHADOS (Fase 2 campos configuráveis, decisão 18):
 * funções puras usadas pelos DTOs Zod e services de qualquer módulo.
 * Espelho no app: package setes_validators (decisão 22) — manter as regras
 * IDÊNTICAS nos dois lados (API = fonte da verdade, decisão 1).
 *
 * Dados chegam e são gravados SEM máscara (decisão 19).
 *
 * INSCRIÇÃO FEDERAL (CPF/CNPJ — D-CJ2, frente do CNPJ alfanumérico, 2026-10-15): a regra NÃO mora mais aqui — é a peça pura do núcleo
 * (`fiscal-api/federal-id`), reexportada abaixo (a superfície da decisão 18 fica; a implementação vira uma só, com o espelho Dart lendo o
 * MESMO vetor de casos). CNPJ = 12 alfanuméricos MAIÚSCULOS + 2 DV numéricos (DV ASCII − 48); "normalizar" = canonicalizar, NUNCA apagar.
 * O antigo "tira o que não é dígito" morreu com a pesquisa por documento (D-CJ9): aplicado a um CNPJ alfanumérico dá OUTRO número.
 */
export {
  isValidCpf, isValidCnpj, normalizeCnpj, normalizeCpf, canonicalizeFederalIdText, formatCnpj, formatCpf, readFederalIdFact,
} from 'fiscal-api/federal-id'
export type { FederalId, FederalIdKind, FederalIdFact } from 'fiscal-api/federal-id'

/** true se o valor contém apenas dígitos (vazio conta como true). */
export function isOnlyDigits(value: string): boolean {
  return /^\d*$/.test(value)
}

/**
 * Valor casa com a máscara? Padrão técnico da casa (decisão 16):
 * `#` = dígito, `A` = letra, qualquer outro caractere é literal obrigatório.
 * Ex.: matchesMask('(##) #-####-####', '(31) 9-8888-7777') === true.
 * Máscara vazia/nula = sem restrição.
 */
export function matchesMask(mask: string | null | undefined, value: string): boolean {
  if (!mask) return true
  if (mask.length !== value.length) return false
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i]
    const c = value[i]
    if (m === '#') { if (!/\d/.test(c)) return false }
    else if (m === 'A') { if (!/[a-zA-ZÀ-ÿ]/.test(c)) return false }
    else if (m !== c) return false
  }
  return true
}

/**
 * Data de CALENDÁRIO em 'YYYY-MM-DD'. O regex de formato sozinho aceita
 * '2026-13-45', e o MariaDB sem strict mode grava isso como '0000-00-00' —
 * o gate adversarial da Onda 1 (fase Primeiro Cliente) faturou uma ordem com
 * vencimento zerado no título E no BOLETO, que é imutável por decisão.
 * Aqui a data tem que EXISTIR: o round-trip prova mês e dia.
 */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1) return false
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y
      && date.getUTCMonth() === m - 1
      && date.getUTCDate() === d
}
