import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'

/**
 * SÉRIE DA NOTA por modelo — D-F112 (= Q-F118 (a), Valdo 2026-10-12 — F2a, `prompt_apis_fiscais_isoladas.md` §22.6): o que
 * sobra no ERP de `@shared/fiscal-issuer` depois que a habilitação para falar com o fisco muda de casa (D-F42/D-F44). Leitura SÓ:
 * `tb_establishment_issuer` do schema do cliente, linha VIVA do modelo → `serie`; sem linha = '1' (a config `invoice_serie` foi
 * aposentada no seed 58 — D-E2). Depois do ATO da virada a linha SE do ERP está aposentada (`deleted='S'`, D-F44) e a série da
 * NFS-e é '1' — o próprio ato confere que a série era '1' antes de aposentar (falha alto se não). A 55/65 segue viva aqui como
 * série do faturamento (D-F21). Sem tela até o 1º cliente de mercadoria; a forma definitiva (config × tabela) se decide com o
 * leiaute real da NF-e.
 *
 * Nada aqui escreve, nem decide habilitação, ambiente, contador do DPS ou A1 — isso é das APIs fiscais (D-F10/D-F16).
 */

export type InvoiceModel = 'SE' | '55' | '65'

type Q = PoolConnection | typeof pool

export async function invoiceSerieFor(q: Q, schemaName: string, institutionId: number, model: InvoiceModel): Promise<string> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT serie FROM \`${s}\`.tb_establishment_issuer
      WHERE tb_institution_id = ? AND model = ? AND deleted = 'N' LIMIT 1`,
    [institutionId, model]
  )
  return String(rows[0]?.serie ?? '1').slice(0, 10)
}
