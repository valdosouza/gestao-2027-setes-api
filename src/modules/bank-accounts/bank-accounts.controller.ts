import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { bankAccountDto } from './bank-accounts.dto'
import {
  BankAccountScope, fetchBankAccounts, fetchBankAccount, createBankAccount,
  editBankAccount, removeBankAccount, fetchBanksLookup,
} from './bank-accounts.service'

/** Escopo SEMPRE do JWT (cadastro por institution). */
function scopeOf(req: Request): BankAccountScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'bank-accounts')
    res.json(pagedEnvelope(query, await fetchBankAccounts(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'bank-accounts GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchBankAccount(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'bank-accounts/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(bankAccountDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'bank-accounts', body)
    const id = await createBankAccount(body, scopeOf(req))
    logger.info('Conta bancária criada', {
      institutionId: req.institution!.institutionId, id,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'bank-accounts POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(bankAccountDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'bank-accounts', body)
    await editBankAccount(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'bank-accounts/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeBankAccount(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'bank-accounts/:id DELETE')
  }
}

export async function banksLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchBanksLookup(filter) })
  } catch (err) {
    handleError(res, err, 'bank-accounts/banks GET')
  }
}
