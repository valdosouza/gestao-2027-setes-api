import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { escapeLike } from '@shared/list'

/**
 * Lista de apoio das CONTAS BANCÁRIAS da institution (D-PV2, 2026-10-18 — `prompt_privilegios_interfaces.md`).
 *
 * Nasce da guarda por roteador: as telas de Baixas e de Caixa liam `GET /api/bank-accounts` (o módulo de OUTRA tela) —
 * com a guarda, isso exigiria VISUALIZAR em Contas Bancárias de quem só opera a baixa/o caixa. Regra vigente: o módulo do
 * app fala só com o SEU `/api/<m>`; o dado vem desta peça (2 consumidores → shared). Mesmo conjunto de linhas da lista do
 * cadastro (`bank-accounts.repository.ts` — institution, `deleted='N'`, mesmo filtro e ordem), com os campos que as duas
 * telas leem (banco, agência e conta separados — a tela monta o rótulo).
 */
export interface BankAccountLookupRow {
  id: number
  bankNumber: string | null
  bankDescription: string | null
  agency: string | null
  agencyDv: string | null
  number: string | null
  numberDv: string | null
}

export async function listBankAccountLookup(
  schemaName: string, institutionId: number, filter = '', limit = 100
): Promise<BankAccountLookupRow[]> {
  const s = assertSchema(schemaName)
  const f = filter.trim()
  const like = f ? `%${escapeLike(f)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT a.id, b.number AS bankNumber, b.description AS bankDescription,
            a.agency, a.agency_dv AS agencyDv, a.number, a.number_dv AS numberDv
       FROM \`${s}\`.tb_bank_account a
       LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id
      WHERE a.tb_institution_id = ? AND a.deleted = 'N'
        AND (? IS NULL OR b.description LIKE ? OR b.number LIKE ? OR a.number LIKE ?)
      ORDER BY b.description, a.agency, a.number, a.id
      LIMIT ?`,
    [institutionId, like, like, like, like, limit]
  )
  return rows.map(r => ({
    id: Number(r.id),
    bankNumber: r.bankNumber ?? null, bankDescription: r.bankDescription ?? null,
    agency: r.agency ?? null, agencyDv: r.agencyDv ?? null,
    number: r.number ?? null, numberDv: r.numberDv ?? null,
  }))
}
