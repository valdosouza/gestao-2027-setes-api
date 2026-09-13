import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { ListQuery, PagedRows } from '@shared/list'
import { findOpenSlip } from '@shared/bank-slip'
import {
  retargetTitleCharge, RetargetTitleChargeResult,
} from '@shared/title-charge'
import { RetargetChargeDto } from './settlements.dto'
import {
  BillRow, SettleBatchInput, SettleBatchResult, SettledRow,
  ReversalInput, ReversalResult, StatementReport,
} from './settlements.interface'
import {
  listBills, settleBatch, listSettled, reverseSettlement, listStatements,
} from './settlements.repository'

/**
 * Regras do módulo settlements: escopo SEMPRE da institution do JWT
 * (usuário assina o movimento); imutabilidade e máquina de estados vivem
 * no repositório (transações + FOR UPDATE + 409).
 */

export interface SettlementScope {
  schemaName:    string
  institutionId: number
  userId:        number
}

export async function fetchBills(
  status: 'open' | 'settled' | '', kind: string, query: ListQuery,
  scope: SettlementScope
): Promise<PagedRows<BillRow>> {
  return listBills(status, kind, query, scope.schemaName, scope.institutionId)
}

export async function settle(
  input: SettleBatchInput, scope: SettlementScope
): Promise<SettleBatchResult> {
  return settleBatch(input, scope.schemaName, scope.institutionId, scope.userId)
}

export async function fetchSettled(
  query: ListQuery, scope: SettlementScope
): Promise<PagedRows<SettledRow>> {
  return listSettled(query, scope.schemaName, scope.institutionId)
}

export async function reverse(
  input: ReversalInput, scope: SettlementScope
): Promise<ReversalResult> {
  return reverseSettlement(input, scope.schemaName, scope.institutionId, scope.userId)
}

export async function fetchStatements(
  bankAccountId: number | null, dtFrom: string | null, dtTo: string | null,
  scope: SettlementScope
): Promise<StatementReport> {
  return listStatements(bankAccountId, dtFrom, dtTo,
    scope.schemaName, scope.institutionId)
}

/**
 * Redireciona a cobrança de um título (D17 — "a casa da alteração é no
 * financeiro"). COMPOSIÇÃO: a peça `@shared/title-charge` escreve a condição e
 * o `@shared/bank-slip` diz se há cobrança em curso. É aqui, no módulo, que as
 * duas se encontram — a peça geral não conhece boleto.
 */
export async function retargetCharge(
  orderId: number, parcel: number, input: RetargetChargeDto, scope: SettlementScope
): Promise<RetargetTitleChargeResult> {
  return withDeadlockRetry('redirecionar cobrança', { orderId, parcel }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      // Guarda do INSTRUMENTO, antes de escrever: boleto vigente e forma nova
      // se contradiriam (o cliente está com um papel na mão dizendo outra coisa).
      const slip = await findOpenSlip(conn, scope.schemaName, scope.institutionId,
        { orderId, parcel })
      if (slip !== null) {
        throw new HttpError(409,
          `Título ${orderId}/${parcel} tem o boleto ${slip} vigente — cancele o boleto antes de redirecionar a cobrança`,
          [{ field: 'paymentTypeId', message: `Boleto ${slip} vigente` }],
          'TITLE_HAS_OPEN_SLIP')
      }

      const r = await retargetTitleCharge(conn, scope.schemaName, scope.institutionId, {
        orderId, parcel,
        paymentTypeId: input.paymentTypeId,
        dtExpiration:  input.dtExpiration ?? null,
      })

      await conn.commit()
      return r
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  })
}
