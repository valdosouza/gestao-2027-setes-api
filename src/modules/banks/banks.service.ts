import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { ListQuery, PagedRows } from '@shared/list'
import { BankRow } from './banks.interface'
import {
  listBanks, getBank, bankNumberExists, getBankByNumber,
  insertBank, updateBank, deleteBank, listBankUsage, reviveBank,
} from './banks.repository'

export async function fetchBanks(query: ListQuery): Promise<PagedRows<BankRow>> {
  return listBanks(query)
}

export async function fetchBank(id: number): Promise<BankRow> {
  const row = await getBank(id)
  if (!row) throw new HttpError(404, `Banco ${id} não encontrado`)
  return row
}

/**
 * Cria banco: id interno MAX+1; número FEBRABAN digitado e único — 409 só
 * se o número estiver VIVO. Número de banco EXCLUÍDO faz a MESMA linha
 * reviver com a descrição nova (id preservado; decisão do Valdo 2026-08-04:
 * soft delete → restaurável — padrão revive do provider). Cadastro geral da
 * central, sem cadeia fiscal.
 */
export async function createBank(number: string, description: string): Promise<{ id: number }> {
  const existing = await getBankByNumber(number)
  if (existing) {
    if (existing.deleted === 'N') {
      throw new HttpError(409, `Já existe um banco com o número ${number}`,
        [{ field: 'number', message: 'Número já cadastrado' }])
    }
    await reviveBank(existing.id, description)
    return { id: existing.id }
  }
  try {
    const id = await insertBank(number, description)
    return { id }
  } catch (err: any) {
    // Corrida entre a verificação e o INSERT: o UNIQUE duplicado vira 409
    // também — com o MESMO shape de fields[] da pré-checagem (Framework de
    // Mensagens: o app destaca o campo nos dois caminhos).
    if (err?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, `Já existe um banco com o número ${number}`,
        [{ field: 'number', message: 'Número já cadastrado' }])
    }
    throw err
  }
}

/**
 * Edição permite corrigir o número (não é a PK; contas correntes apontam
 * para o id) — mantida a unicidade com 409.
 */
export async function editBank(id: number, number: string, description: string): Promise<void> {
  await fetchBank(id) // garante existência
  if (await bankNumberExists(number, id)) {
    throw new HttpError(409, `Já existe um banco com o número ${number} (mesmo que excluído)`,
      [{ field: 'number', message: 'Número já cadastrado' }])
  }
  try {
    await updateBank(id, number, description)
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, `Já existe um banco com o número ${number}`,
        [{ field: 'number', message: 'Número já cadastrado' }])
    }
    throw err
  }
}

/**
 * Exclusão bloqueada com o banco EM USO por conta corrente viva de qualquer
 * schema (padrão da casa: DELETE 409 quando referenciado — categories/
 * financial-plans; achado HIGH do gate adversarial 2026-08-04: excluído em
 * uso quebra a edição de contas de todos os clientes e é irreversível pela
 * API, pois o number não se reaproveita).
 */
export async function removeBank(id: number): Promise<void> {
  await fetchBank(id)
  const used = await listBankUsage(id)
  if (used.length > 0) {
    throw new HttpError(409,
      `Banco em uso por conta corrente de ${used.length} estabelecimento(s) — exclusão bloqueada`,
      undefined, ErrorCodes.BANK_IN_USE)
  }
  await deleteBank(id)
}
