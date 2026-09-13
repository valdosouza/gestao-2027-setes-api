import { PoolConnection } from 'mysql2/promise'
import { HttpError } from '@shared/errors/http-error'

/**
 * Guarda ÚNICA "este produto é um SERVIÇO vivo" (existe, não deletado, ativo,
 * kind 'S'). Nasceu na OS (Q-A17/Q-A20 do cancelamento de nota: POST e PUT do
 * item + cinto no faturamento) e virou peça em Q-G27 (Valdo 2026-09-10,
 * "ambos"): o CONTRATO do Software House valida seus itens pela mesma regra e a
 * rotina mensal pula/reporta o que ficou inválido depois (produto inativado ou
 * trocado no cadastro).
 *
 * Leitura transacional (conn) — quem chama já está na transação que grava.
 */
export async function assertServiceProduct(
  conn: PoolConnection, schemaName: string, institutionId: number, productId: number
): Promise<void> {
  const [prod] = await conn.query<any[]>(
    `SELECT kind, active FROM \`${schemaName}\`.tb_product
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [productId, institutionId]
  )
  if (prod.length === 0 || String(prod[0].active) !== 'S') {
    throw new HttpError(400, 'Produto/serviço inexistente ou inativo',
      [{ field: 'productId', message: 'Produto não encontrado' }],
      'PRODUCT_NOT_FOUND')
  }
  if (String(prod[0].kind) !== 'S') {
    throw new HttpError(422, 'O item precisa ser um SERVIÇO',
      [{ field: 'productId', message: 'Produto de mercadoria não entra aqui' }],
      'SERVICE_ORDER_ITEM_NOT_SERVICE')
  }
}

/** Mesma regra, sem lançar: motivo legível ou null (rotina mensal — pula e reporta). */
export async function serviceProductIssue(
  conn: PoolConnection, schemaName: string, institutionId: number, productId: number
): Promise<string | null> {
  const [prod] = await conn.query<any[]>(
    `SELECT kind, active FROM \`${schemaName}\`.tb_product
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [productId, institutionId]
  )
  if (prod.length === 0 || String(prod[0].active) !== 'S') return 'produto inexistente ou inativo'
  if (String(prod[0].kind) !== 'S') return 'produto não é serviço'
  return null
}
