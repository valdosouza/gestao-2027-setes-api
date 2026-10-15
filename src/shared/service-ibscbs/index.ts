/**
 * Peça @shared/service-ibscbs — a PRESUNÇÃO IBS/CBS do serviço (fase IBS/CBS, IB-2 — prompt_fase_ibs_cbs.md §12.3;
 * D-IB6/D-IB70/D-IB71): o que o CADASTRO do serviço presume — NBS (`tb_service.nbs`) e classificação (peça 1:1
 * `tb_service_ibscbs`: cClassTrib + cIndOp escolhidos). Só LÊ; quem decide a declaração da nota é a regra da peça
 * `@shared/ibscbs-classification` (via a composição `@shared/service-ibscbs-declaration`).
 *
 * - Só produto VIVO (limite do §11.11 da fase: excluir o serviço não mata a 1:1 — todo leitor exige o produto vivo);
 *   produto ausente volta SEM presunção (a regra o trata como "sem classificação"/"sem NBS").
 * - D-IB70: dentro da transação do faturamento a leitura é TRAVANTE COMPARTILHADA (`lock: true` — PADROES §9 regra 2:
 *   decide gravação e mensagem); o pré-voo (só pergunta) lê sem trava.
 * - ⚠️ TRÊS leituras, na MESMA ordem do `PUT /services` (tb_product → tb_service → tb_service_ibscbs — gate socrático da
 *   IB-2): um único SELECT com LEFT JOIN travante intercala as travas por linha (produto A, intervalo da 1:1 ausente de A,
 *   produto B…) e fecha ciclo com o PUT de B (que segura o produto B e insere a 1:1 dentro daquele intervalo) — 1213.
 *   Travando TODOS os produtos antes de tocar a 1:1, o faturamento espera o PUT terminar em vez de cruzar com ele
 *   (provado em schema descartável: scripts/prove-ibscbs-presumption-lock.ts).
 */

export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> }

export interface PresumptionRequest {
  productId: number
  /** Campo do 422 que o faturamento lança (`item.N` na venda, `product.N` na OS). */
  field:     string
}

export interface ServicePresumptionRow {
  productId:          number
  description:        string
  field:              string
  nbs:                string | null
  classificationCode: string | null
  placeIndicatorCode: string | null
}

const SCHEMA_RE = /^[A-Za-z0-9_]+$/

/** Presunção de cada serviço pedido (um por produto, na ordem do 1º pedido de cada um). */
export async function readServicePresumptions(
  q: Queryable, schemaName: string, institutionId: number,
  requests: readonly PresumptionRequest[], opts: { lock: boolean },
): Promise<ServicePresumptionRow[]> {
  if (!SCHEMA_RE.test(schemaName)) throw new Error(`schema inválido: ${schemaName}`)
  const firstField = new Map<number, string>()
  for (const r of requests) if (!firstField.has(r.productId)) firstField.set(r.productId, r.field)
  const ids = [...firstField.keys()]
  if (ids.length === 0) return []
  const lock = opts.lock ? '\n      LOCK IN SHARE MODE' : ''
  const s = `\`${schemaName}\``

  // 1º TODOS os produtos (a trava que o PUT do serviço toma primeiro)
  const [products] = await q.query(
    `SELECT p.id AS productId, p.description
       FROM ${s}.tb_product p
      WHERE p.tb_institution_id = ? AND p.id IN (?) AND p.deleted = 'N'
      ORDER BY p.id${lock}`,
    [institutionId, ids])
  const alive = (products as any[]).map(r => Number(r.productId))
  const byProduct = new Map<number, any>((products as any[]).map(r => [Number(r.productId), r]))
  let nbsById = new Map<number, string | null>()
  let clsById = new Map<number, { c: string; p: string }>()
  if (alive.length > 0) {
    // 2º a natureza do serviço (NBS)
    const [services] = await q.query(
      `SELECT sv.id, sv.nbs
         FROM ${s}.tb_service sv
        WHERE sv.tb_institution_id = ? AND sv.id IN (?) AND sv.deleted = 'N'
        ORDER BY sv.id${lock}`,
      [institutionId, alive])
    nbsById = new Map((services as any[]).map(r => [Number(r.id), r.nbs ?? null]))
    // 3º a classificação (peça 1:1)
    const [classified] = await q.query(
      `SELECT si.id, si.classification_code AS c, si.place_indicator_code AS p
         FROM ${s}.tb_service_ibscbs si
        WHERE si.tb_institution_id = ? AND si.id IN (?) AND si.deleted = 'N'
        ORDER BY si.id${lock}`,
      [institutionId, alive])
    clsById = new Map((classified as any[]).map(r => [Number(r.id), { c: r.c, p: r.p }]))
  }
  return ids.map(id => {
    const p = byProduct.get(id)
    const cls = p ? clsById.get(id) : undefined
    return {
      productId:          id,
      description:        p?.description ? String(p.description) : `Serviço ${id}`,
      field:              firstField.get(id)!,
      nbs:                p ? nbsById.get(id) ?? null : null,
      classificationCode: cls?.c ?? null,
      placeIndicatorCode: cls?.p ?? null,
    }
  })
}
