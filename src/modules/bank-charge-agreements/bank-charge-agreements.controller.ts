import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { chargeAgreementDto } from './bank-charge-agreements.dto'
import {
  ChargeAgreementScope, fetchChargeAgreements, fetchChargeAgreement, createChargeAgreement,
  editChargeAgreement, removeChargeAgreement, fetchBankAccountsLookup,
} from './bank-charge-agreements.service'

/** Escopo SEMPRE do JWT (cadastro por institution). */
function scopeOf(req: Request): ChargeAgreementScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'bank-charge-agreements')
    res.json(pagedEnvelope(query, await fetchChargeAgreements(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'bank-charge-agreements GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchChargeAgreement(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'bank-charge-agreements/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(chargeAgreementDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'bank-charge-agreements', body)
    const id = await createChargeAgreement(body, scopeOf(req))
    logger.info('Carteira de cobrança criada', {
      institutionId: req.institution!.institutionId, id,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'bank-charge-agreements POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(chargeAgreementDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'bank-charge-agreements', body)
    await editChargeAgreement(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'bank-charge-agreements/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeChargeAgreement(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'bank-charge-agreements/:id DELETE')
  }
}

export async function bankAccountsLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchBankAccountsLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'bank-charge-agreements/bank-accounts GET')
  }
}
