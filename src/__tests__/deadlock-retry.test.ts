/// <reference types="jest" />
import { withDeadlockRetry } from '../shared/db/deadlock-retry'

describe('withDeadlockRetry', () => {
  it('sucesso de primeira -> nenhum retry', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    expect(await withDeadlockRetry('x', {}, 3, fn)).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('ER_LOCK_DEADLOCK reexecuta até o teto de tentativas e então propaga', async () => {
    const err = Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })
    const fn = jest.fn().mockRejectedValue(err)
    await expect(withDeadlockRetry('x', {}, 3, fn)).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('deadlock nas 2 primeiras, sucesso na 3ª', async () => {
    const err = Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })
    const fn = jest.fn().mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockResolvedValueOnce('ok')
    expect(await withDeadlockRetry('x', {}, 3, fn)).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('erro que NÃO é deadlock propaga na hora, sem retry', async () => {
    const err = Object.assign(new Error('outro'), { code: 'ER_DUP_ENTRY' })
    const fn = jest.fn().mockRejectedValue(err)
    await expect(withDeadlockRetry('x', {}, 3, fn)).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
