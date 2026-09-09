/// <reference types="jest" />
// Q-A3 (cancelamento de nota, Valdo 2026-09-09 — transversal): lock wait
// (ER_LOCK_WAIT_TIMEOUT) é contenção normal → 409 RESOURCE_BUSY em TODOS os
// módulos, sem crashlytics; deadlock continua técnico (o retry já reexecutou).
import { contentionToHttpError, isLockWaitTimeout } from '../shared/db/contention'
import { handleError } from '../shared/http/controller-utils'
import { HttpError } from '../shared/errors/http-error'

jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true,
  newCrashRef: jest.fn(() => 'REF00001'),
  recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/logger/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
const crash = jest.requireMock('../shared/errors/crash.repository') as any

function fakeRes() {
  const res: any = { req: { institution: { institutionId: 1, userId: 7 } } }
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}
beforeEach(() => jest.clearAllMocks())

describe('@shared/db/contention', () => {
  it('só ER_LOCK_WAIT_TIMEOUT é contenção', () => {
    expect(isLockWaitTimeout({ code: 'ER_LOCK_WAIT_TIMEOUT' })).toBe(true)
    expect(isLockWaitTimeout({ code: 'ER_LOCK_DEADLOCK' })).toBe(false)
    expect(contentionToHttpError({ code: 'ER_LOCK_DEADLOCK' })).toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect(contentionToHttpError(new Error('x'))).toBeNull()
    expect(contentionToHttpError({ code: 'ER_LOCK_WAIT_TIMEOUT' })).toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
  })
})

describe('handleError × contenção', () => {
  it('lock wait → 409 RESOURCE_BUSY, sem ref e sem crashlytics', () => {
    const res = fakeRes()
    handleError(res, Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' }), 'checks.deposit')
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/em uso/), code: 'RESOURCE_BUSY' })
    expect(crash.recordCrash).not.toHaveBeenCalled()
  })
  it('deadlock que chegou à borda (retry esgotado ou porta sem retry) → 409 RESOURCE_BUSY, sem crashlytics (L4)', () => {
    const res = fakeRes()
    handleError(res, Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' }), 'billing.cancel')
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/em uso/), code: 'RESOURCE_BUSY' })
    expect(crash.recordCrash).not.toHaveBeenCalled()
  })
  it('erro técnico de verdade continua 500 com ref', () => {
    const res = fakeRes()
    handleError(res, new Error('boom'), 'ctx')
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERNAL', ref: 'REF00001' }))
    expect(crash.recordCrash).toHaveBeenCalledTimes(1)
  })
  it('HttpError passa intacta (contrato {error, code, fields})', () => {
    const res = fakeRes()
    handleError(res, new HttpError(409, 'x', [{ field: 'a', message: 'b' }], 'ANY'), 'ctx')
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'x', code: 'ANY', fields: [{ field: 'a', message: 'b' }] })
  })
})
