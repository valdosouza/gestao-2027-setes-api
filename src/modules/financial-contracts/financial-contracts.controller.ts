import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { financialContractCreateDto, financialContractUpdateDto } from './financial-contracts.dto'
import {
  FinancialContractScope, fetchFinancialContracts, fetchFinancialContract,
  createFinancialContract, editFinancialContract, removeFinancialContract,
  fetchPaymentTypesLookup, fetchBankAccountsLookup,
} from './financial-contracts.service'

/** Escopo SEMPRE do JWT (cadastro por institution). */
function scopeOf(req: Request): FinancialContractScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'financial-contracts')
    res.json(pagedEnvelope(query, await fetchFinancialContracts(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'financial-contracts GET')
  }
}

/** :id = tb_payment_types_id (PK compartilhada com o vínculo — D2). */
export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchFinancialContract(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'financial-contracts/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(financialContractCreateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'financial-contracts', body)
    const id = await createFinancialContract(body, scopeOf(req))
    logger.info('Contrato financeiro criado', {
      institutionId: req.institution!.institutionId, paymentTypeId: id,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'financial-contracts POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(financialContractUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'financial-contracts', body)
    await editFinancialContract(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'financial-contracts/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeFinancialContract(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'financial-contracts/:id DELETE')
  }
}

export async function paymentTypesLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchPaymentTypesLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'financial-contracts/payment-types GET')
  }
}

export async function bankAccountsLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchBankAccountsLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'financial-contracts/bank-accounts GET')
  }
}
