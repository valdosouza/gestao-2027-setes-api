import { PoolConnection } from 'mysql2/promise'

/**
 * Peça compartilhada das FORMAS DE PAGAMENTO (workflow do Valdo,
 * 2026-07-18): catálogo CENTRAL em setes_central.tb_payment_types (cliente
 * inicia o cadastro — reuso por DESCRIÇÃO na transação, mesmo espírito da
 * entidade única) + vínculo por institution em setes_<schema>.
 * tb_institution_has_payment_types. Helpers TRANSACTION-AWARE (1º parâmetro
 * = conn) — consumidos pelo módulo payment-types e pelo wallet/"Carteira"
 * do customers (regra de promoção: 2º consumidor).
 */

/**
 * Garante a forma no catálogo CENTRAL pela DESCRIÇÃO: existente = reusa;
 * inexistente = cria com id MAX+1 (FOR UPDATE). Devolve { id, reused }.
 */
export async function ensureCatalogPaymentType(
  conn: PoolConnection, description: string, idNfce: string | null
): Promise<{ id: number; reused: boolean }> {
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM setes_central.tb_payment_types
      WHERE description = ? AND deleted = 'N' LIMIT 1 FOR UPDATE`,
    [description]
  )
  if (rows.length > 0) return { id: Number(rows[0].id), reused: true }

  const [mx] = await conn.query<any[]>(
    'SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_payment_types FOR UPDATE'
  )
  const id = Number(mx[0].nextId)
  await conn.query(
    `INSERT INTO setes_central.tb_payment_types
       (id, description, id_nfce, created_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())`,
    [id, description, idNfce]
  )
  return { id, reused: false }
}

/**
 * Configuração operacional do VÍNCULO (migration 012). enable substitui o
 * antigo active (a linha do catálogo é compartilhada — o cliente desabilita
 * por um tempo, não exclui); usagePreference: lançamento em 'C'aixa /
 * 'B'anco / 'A'mbos. Planos de conta por coluna sem FK física (0 = não
 * definido).
 */
export interface PaymentTypeLinkAttrs {
  enable:                  'S' | 'N'
  appMobile:               'S' | 'N'
  blockForCustomerBlocked: 'S' | 'N'
  blockForCustomerNoLimit: 'S' | 'N'
  maxParcels:              number
  tef:                     'S' | 'N'
  financialPlansIdCre:     number
  financialPlansIdDeb:     number
  usagePreference:         'C' | 'B' | 'A'
}

export const DEFAULT_LINK_ATTRS: PaymentTypeLinkAttrs = {
  enable: 'S', appMobile: 'N', blockForCustomerBlocked: 'N',
  blockForCustomerNoLimit: 'N', maxParcels: 1, tef: 'N',
  financialPlansIdCre: 0, financialPlansIdDeb: 0, usagePreference: 'A',
}

/**
 * Upsert do VÍNCULO institution × forma (ressuscita soft-deleted).
 * Sem [attrs] (ex.: wallet/"Carteira" do customers) o vínculo nasce com os
 * defaults e, se JÁ existe, a configuração do cliente NÃO é sobrescrita —
 * só ressuscita; com [attrs] (tela de Formas de Pagamento) sobrescreve.
 */
export async function upsertLink(
  conn: PoolConnection, schemaName: string, institutionId: number,
  paymentTypeId: number, attrs?: PaymentTypeLinkAttrs
): Promise<void> {
  const a = attrs ?? DEFAULT_LINK_ATTRS
  const overwrite = attrs != null
    ? `\`enable\` = VALUES(\`enable\`), app_mobile = VALUES(app_mobile),
       block_for_customer_blocked = VALUES(block_for_customer_blocked),
       block_for_customer_no_limit = VALUES(block_for_customer_no_limit),
       max_parcels = VALUES(max_parcels), tef = VALUES(tef),
       tb_financial_plans_id_cre = VALUES(tb_financial_plans_id_cre),
       tb_financial_plans_id_deb = VALUES(tb_financial_plans_id_deb),
       usage_preference = VALUES(usage_preference),`
    : ''
  await conn.query(
    `INSERT INTO ?? (tb_institution_id, tb_payment_types_id, \`enable\`,
       app_mobile, block_for_customer_blocked, block_for_customer_no_limit,
       max_parcels, tef, tb_financial_plans_id_cre, tb_financial_plans_id_deb,
       usage_preference, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       ${overwrite}
       deleted = 'N', updated_at = NOW()`,
    [`${schemaName}.tb_institution_has_payment_types`, institutionId,
     paymentTypeId, a.enable, a.appMobile, a.blockForCustomerBlocked,
     a.blockForCustomerNoLimit, a.maxParcels, a.tef,
     a.financialPlansIdCre, a.financialPlansIdDeb, a.usagePreference]
  )
}
