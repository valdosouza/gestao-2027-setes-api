import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { openBankChannel } from '@shared/bank-channel'
import {
  registerBankSlip, refreshRegistration, refreshOpenRegistrations, cancelRegisteredBankSlip,
  reapplyRegistrationEffect, latestRegistration, isLive, listSlipRegistrations,
  RegisterResult, RefreshResult, RefreshRunReport, CancelRegisteredResult, ReapplyEffectResult,
} from '@shared/bank-slip-registration'
import { BankSlipScope } from './bank-slips.service'

/**
 * Sub-recurso REGISTRO NO BANCO do módulo bank-slips (Onda 2): o módulo só
 * compõe a peça — nenhuma regra aqui. Quem decide é @shared/bank-slip-registration.
 */

export async function registerSlip(id: number, scope: BankSlipScope): Promise<RegisterResult> {
  return registerBankSlip(scope.schemaName, scope.institutionId, scope.userId, id)
}

export async function refreshSlip(id: number, scope: BankSlipScope): Promise<RefreshResult> {
  return refreshRegistration(scope.schemaName, scope.institutionId, scope.userId, id, 'Q')
}

export async function refreshAll(scope: BankSlipScope, opts: { minMinutes?: number; limit?: number }): Promise<RefreshRunReport> {
  return refreshOpenRegistrations(scope.schemaName, scope.institutionId, scope.userId, opts)
}

/** D-I25: ato manual — reaplica o efeito de uma voz R/C/V recusada na hora (nunca automático). */
export async function reapplyEffect(id: number, attempt: number, event: number, scope: BankSlipScope): Promise<ReapplyEffectResult> {
  return reapplyRegistrationEffect(scope.schemaName, scope.institutionId, scope.userId, id, attempt, event)
}

export async function cancelRegistered(id: number, note: string | null, scope: BankSlipScope): Promise<CancelRegisteredResult> {
  return cancelRegisteredBankSlip(scope.schemaName, scope.institutionId, scope.userId, id, note)
}

export async function fetchRegistrations(id: number, scope: BankSlipScope) {
  return listSlipRegistrations(scope.schemaName, scope.institutionId, id)
}

async function slipBankAccountId(id: number, scope: BankSlipScope): Promise<number> {
  const [rows] = await pool.query<any[]>(
    `SELECT tb_bank_account_id AS bankAccountId FROM \`${scope.schemaName}\`.tb_bank_slip
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`, [id, scope.institutionId])
  if (!rows[0]) throw new HttpError(404, `Boleto ${id} não encontrado`, undefined, 'BANK_SLIP_NOT_FOUND')
  return Number(rows[0].bankAccountId)
}

/** PDF oficial do banco (base64 no envelope — o app abre/baixa). */
export async function fetchSlipPdf(id: number, scope: BankSlipScope): Promise<{ pdfBase64: string; requestCode: string }> {
  const reg = await latestRegistration(pool, scope.schemaName, scope.institutionId, id)
  if (!reg?.requestCode) throw new HttpError(409, 'Boleto ainda não registrado no banco — sem PDF oficial', undefined, 'BANK_SLIP_NOT_REGISTERED')
  const bankAccountId = await slipBankAccountId(id, scope)
  const opened = await openBankChannel(scope.schemaName, scope.institutionId, bankAccountId, { environment: reg.environment })
  const pdf = await opened.adapter.pdf(opened.ctx, reg.requestCode)
  return { pdfBase64: pdf.toString('base64'), requestCode: reg.requestCode }
}

/** SANDBOX: simula o pagamento no banco e já consulta (prova do critério 2). */
export async function paySandbox(id: number, via: 'BOLETO' | 'PIX', scope: BankSlipScope): Promise<RefreshResult> {
  const reg = await latestRegistration(pool, scope.schemaName, scope.institutionId, id)
  if (!reg?.requestCode || !isLive(reg)) throw new HttpError(409, 'Boleto sem apresentação vigente no banco', undefined, 'BANK_SLIP_NOT_REGISTERED')
  if (reg.environment !== 'S') throw new HttpError(409, 'Pagamento simulado só existe no sandbox', undefined, 'BANK_REJECTED')
  const bankAccountId = await slipBankAccountId(id, scope)
  const opened = await openBankChannel(scope.schemaName, scope.institutionId, bankAccountId, { environment: 'S' })
  await opened.adapter.paySandbox(opened.ctx, reg.requestCode, via)
  return refreshRegistration(scope.schemaName, scope.institutionId, scope.userId, id, 'Q')
}
