import { Request, Response } from 'express'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import {
  customerCreateDto, customerUpdateDto, customerPartnershipDto,
} from './customers.dto'
import {
  CustomerScope, fetchCustomers, fetchCustomer, createCustomer,
  editCustomer, removeCustomer, fetchSalesmanLookup, fetchCarrierLookup,
  fetchCustomerPartnership, saveCustomerPartnership,
} from './customers.service'

/** Escopo SEMPRE do JWT (decisão 2 — o papel é por institution). */
function scopeOf(req: Request): CustomerScope {
  const { schemaName, institutionId, userId, role } = req.institution!
  return { schemaName, institutionId, userId, role }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchCustomers(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'customers GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCustomer(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'customers/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(customerCreateDto, req, res)
  if (body === null) return
  try {
    const result = await createCustomer(body, scopeOf(req))
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'customers POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(customerUpdateDto, req, res)
  if (body === null) return
  try {
    await editCustomer(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'customers/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeCustomer(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'customers/:id DELETE')
  }
}

export async function salesmanLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchSalesmanLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'customers/salesman-lookup GET')
  }
}

export async function carrierLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchCarrierLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'customers/carrier-lookup GET')
  }
}

// ---------------------------------------------------------------------
// ABA PARCERIA (Parceria v2)
// ---------------------------------------------------------------------

export async function getPartnership(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true,
      data: { partners: await fetchCustomerPartnership(id, scopeOf(req)) } })
  } catch (err) {
    handleError(res, err, 'customers/:id/partnership GET')
  }
}

export async function putPartnership(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(customerPartnershipDto, req, res)
  if (body === null) return
  try {
    await saveCustomerPartnership(id, body.partners, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'customers/:id/partnership PUT')
  }
}
