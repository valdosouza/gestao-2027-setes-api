import { HttpError } from '@shared/errors/http-error'
import { writeManualCashierMovement } from '@shared/financial-settlement'
import {
  findOpenCashier, openCashier, getCashier, getCashierBalance,
  getRegisteredByPaymentType, withdrawTx, closeCashierTx,
} from './cashier.repository'
import {
  CashierRow, CashierBalance, WithdrawResult, CloseCashierResult,
} from './cashier.interface'
import { WithdrawDto, CloseCashierDto } from './cashier.dto'

export interface CashierScope {
  schemaName: string
  institutionId: number
  userId: number
}

export async function fetchCurrent(scope: CashierScope): Promise<CashierRow | null> {
  return findOpenCashier(scope.schemaName, scope.institutionId, scope.userId)
}

export async function open(scope: CashierScope): Promise<CashierRow> {
  return openCashier(scope.schemaName, scope.institutionId, scope.userId)
}

async function requireCashier(scope: CashierScope, cashierId: number): Promise<CashierRow> {
  const cashier = await getCashier(scope.schemaName, scope.institutionId, cashierId)
  if (!cashier) throw new HttpError(404, `Caixa ${cashierId} não encontrado`)
  return cashier
}

export async function fetchBalance(scope: CashierScope, cashierId: number): Promise<CashierBalance> {
  const cashier = await requireCashier(scope, cashierId)
  const balance = await getCashierBalance(scope.schemaName, scope.institutionId, cashierId)
  const registeredByPaymentType = await getRegisteredByPaymentType(
    scope.schemaName, scope.institutionId, cashierId)
  return { cashier, balance, registeredByPaymentType }
}

export async function withdraw(
  scope: CashierScope, cashierId: number, input: WithdrawDto
): Promise<WithdrawResult> {
  return withdrawTx(scope.schemaName, scope.institutionId, scope.userId, cashierId,
    input.value, input.history, input.destinationBankAccountId)
}

/**
 * Fechamento (T3.6/§5.4): conferência registrado×digitado (Q-Caixa 3 —
 * replica o legado, só REGISTRA a diferença, não bloqueia) + transferência
 * OPCIONAL do saldo total pra uma conta bancária (Q-Caixa "escopo
 * completo").
 */
export async function close(
  scope: CashierScope, cashierId: number, input: CloseCashierDto
): Promise<CloseCashierResult> {
  await requireCashier(scope, cashierId)

  let transferValue = 0
  if (input.transferBankAccountId) {
    transferValue = await getCashierBalance(scope.schemaName, scope.institutionId, cashierId)
  }

  const { hrEnd, closingItems, transferResult } = await closeCashierTx(
    scope.schemaName, scope.institutionId, scope.userId, cashierId, input.items,
    async (conn) => {
      if (!input.transferBankAccountId || transferValue <= 0) return null
      return writeManualCashierMovement(conn, scope.schemaName, scope.institutionId, scope.userId, {
        cashierId, value: transferValue,
        history: `Transferência no fechamento do caixa ${cashierId}`,
        dtRecord: new Date().toISOString().slice(0, 10),
        destinationBankAccountId: input.transferBankAccountId,
      })
    }
  )

  return { cashierId, hrEnd, items: closingItems, transfer: transferResult }
}
