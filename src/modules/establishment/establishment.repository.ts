import pool from '@shared/db/connection'
import {
  getEntityFiscalFull, saveEntityFiscalChain, EntityFiscalFull, EntityFiscalInput,
} from '@shared/entity'

/**
 * Repositório do módulo establishment — CONSUMIDOR da cadeia compartilhada
 * (@shared/entity), sempre pelo institutionId recebido por PARÂMETRO (nunca
 * por :id de rota — IDOR eliminado por construção; o controller/service só
 * repassa req.institution.institutionId).
 *
 * tb_institution.id É o id da própria tb_entity (mesma convenção do
 * institutions.repository: "INNER JOIN setes_central.tb_entity e ON e.id =
 * i.id" — não há coluna entity_id separada), então institutionId serve
 * diretamente como entityId da cadeia. NÃO reimplementa leitura/escrita de
 * endereço/telefone/rede social: delega inteiramente a getEntityFiscalFull/
 * saveEntityFiscalChain.
 */

export async function getEstablishmentChain(institutionId: number): Promise<EntityFiscalFull | null> {
  return getEntityFiscalFull(institutionId)
}

/** PUT: mesma cascade transacional das demais telas da cadeia fiscal. */
export async function saveEstablishmentChain(
  institutionId: number, input: EntityFiscalInput, updatedBy: number | null
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await saveEntityFiscalChain(conn, institutionId, input, updatedBy)
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
