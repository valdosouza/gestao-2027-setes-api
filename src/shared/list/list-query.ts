import { Request } from 'express'
import { getConfigContent } from '@shared/interface-config'

/**
 * Contrato de paginação das listas de pesquisa (prompt_paginacao_telas_pesquisa.md).
 *
 * Decisões: D3 (envelope { ok, data, page, pageSize, total }; endpoint adaptado
 * responde paginado SEMPRE — sem `page` na query = página 1 com default),
 * D4 (sem `pageSize` na query, o default vem da config `page_size` do módulo,
 * resolvida usuário → institution → default pelo Framework de Configurações —
 * a preferência persistida do usuário vale em qualquer dispositivo),
 * D5 (opções de UI 10/25/50/100, default 25, teto absoluto 200 — a API clampa,
 * nunca rejeita) e D10 (LIMIT/OFFSET nesta fase).
 *
 * Todo repository de lista adaptado troca o `LIMIT 200` fixo por
 * `LIMIT ? OFFSET ?` e ganha a contagem irmã com a MESMA cláusula WHERE (D2) —
 * predicados de escopo (institution, carteira do vendedor, soft delete) valem
 * para os dois SELECTs por construção.
 */

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 200
// Teto do page (gate adversarial 2026-08-04): sem ele, page=1e21 passa no
// Number.isInteger e o offset em notação exponencial quebra o LIMIT/OFFSET
// do MySQL — 500 em qualquer lista paginada. Clamp, nunca rejeita (D5).
export const MAX_PAGE = 1_000_000

export interface ListQuery {
  filter:   string
  page:     number   // 1-based
  pageSize: number
  offset:   number   // derivado: (page - 1) * pageSize
}

/**
 * Escapa os metacaracteres de LIKE (decisão do Valdo 2026-08-04, Q3 do
 * gate do módulo banks): sem isso, '_' vira coringa de 1 caractere e '%'
 * casa tudo no filtro digitado pelo usuário. Todo repository que monta
 * `%${filter}%` usa esta peça — o valor segue viajando em placeholder.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, m => `\\${m}`)
}

function toInt(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * Lê e CLAMPA filter/page/pageSize da query string (valor inválido = default).
 * Com [moduleKey], o default de pageSize sai da config `page_size` do módulo
 * (módulo sem catálogo ou request sem JWT caem no DEFAULT_PAGE_SIZE).
 */
export async function parseListQuery(req: Request, moduleKey?: string): Promise<ListQuery> {
  const filter = String(req.query.filter ?? '')
  const page   = Math.min(toInt(req.query.page, 1), MAX_PAGE)

  let fallback = DEFAULT_PAGE_SIZE
  if (moduleKey && req.query.pageSize === undefined && req.institution) {
    const configured = await getConfigContent(req.institution, moduleKey, 'page_size')
    fallback = toInt(configured, DEFAULT_PAGE_SIZE)
  }
  const pageSize = Math.min(toInt(req.query.pageSize, fallback), MAX_PAGE_SIZE)

  return { filter, page, pageSize, offset: (page - 1) * pageSize }
}

/** Par (linhas da página, total com o mesmo WHERE) que os repositories devolvem. */
export interface PagedRows<T> {
  rows:  T[]
  total: number
}

/** Corpo da resposta paginada — metadados no topo, `data` segue sendo o array (D3). */
export function pagedEnvelope<T>(query: ListQuery, result: PagedRows<T>) {
  return {
    ok:       true as const,
    data:     result.rows,
    page:     query.page,
    pageSize: query.pageSize,
    total:    result.total,
  }
}
