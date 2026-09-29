import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import type { IssuerEnvironment, IssuerInput, IssuerModel, IssuerRow } from './fiscal-issuer'
import { FINAL_TRANSMISSION_KINDS } from '@shared/invoice-transmission/transmission-kinds'

/**
 * Acesso a `tb_establishment_issuer` (migration 058 — conceito A da Onda 3,
 * D-N4/D-E1): UMA linha por MODELO do documento (SE · 55 · 65), PK
 * (tb_institution_id, model). O emissor É a institution — nada é duplicado
 * aqui: autoridade é derivada do modelo (peça), certificado vive no cofre por
 * AMBIENTE (secret-store), "habilitado" é derivado (linha + certificado válido —
 * D-E4, sem coluna `active`).
 */

type Q = PoolConnection | typeof pool

const SELECT = (s: string) => `
  SELECT i.tb_institution_id AS institutionId, i.model, i.environment, i.serie, i.tb_user_id AS userId
    FROM \`${s}\`.tb_establishment_issuer i`

function map(r: any): IssuerRow {
  return {
    institutionId: Number(r.institutionId),
    model:         String(r.model) as IssuerModel,
    environment:   r.environment === 'P' ? 'P' : 'H',
    serie:         String(r.serie ?? '1'),
    userId:        r.userId === null || r.userId === undefined ? null : Number(r.userId),
  }
}

export async function listIssuers(schemaName: string, institutionId: number): Promise<IssuerRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `${SELECT(s)} WHERE i.tb_institution_id = ? AND i.deleted = 'N' ORDER BY i.model`,
    [institutionId]
  )
  return rows.map(map)
}

export async function getIssuer(
  q: Q, schemaName: string, institutionId: number, model: IssuerModel, forUpdate = false
): Promise<IssuerRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `${SELECT(s)}
      WHERE i.tb_institution_id = ? AND i.model = ? AND i.deleted = 'N'${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, model]
  )
  return rows[0] ? map(rows[0]) : null
}

/**
 * Cria ou altera a habilitação do modelo; linha excluída REVIVE (deleted = 'N')
 * — a habilitação é ato normal de implantação, não precisa de id novo.
 */
export async function upsertIssuer(
  conn: PoolConnection, schemaName: string, institutionId: number, model: IssuerModel, input: IssuerInput
): Promise<IssuerRow> {
  const s = assertSchema(schemaName)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_establishment_issuer
       (tb_institution_id, model, environment, serie, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       environment = VALUES(environment), serie = VALUES(serie), tb_user_id = VALUES(tb_user_id),
       deleted = 'N', updated_at = NOW()`,
    [institutionId, model, input.environment, input.serie, input.userId]
  )
  const row = await getIssuer(conn, s, institutionId, model)
  if (!row) throw new Error(`Habilitação do emissor ${model} não persistida`)
  return row
}

export async function softDeleteIssuer(
  conn: PoolConnection, schemaName: string, institutionId: number, model: IssuerModel
): Promise<boolean> {
  const s = assertSchema(schemaName)
  const [r] = await conn.query<any>(
    `UPDATE \`${s}\`.tb_establishment_issuer SET deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND model = ? AND deleted = 'N'`,
    [institutionId, model]
  )
  return r.affectedRows > 0
}

/**
 * Vozes do fisco que ENCERRAM uma transmissão do DPS (conceito C): A autorizada ·
 * R rejeitada · C cancelada · F falha explícita. S (enviado) e K (cancelamento
 * em voo) deixam a transmissão VIVA — ela ainda espera resposta no ambiente em
 * que nasceu (environment congelado), e mudar/excluir a habilitação a deixaria
 * sem porta de consulta (espelho da D-I26/D-I27 do canal bancário).
 */
export { FINAL_TRANSMISSION_KINDS }   // fonte única: transmission-kinds.ts (L5)

/**
 * Transmissões VIVAS do modelo SE: linha `tb_invoice_service_transmission`
 * viva cujo ÚLTIMO evento é inexistente (envio em andamento/interrompido) ou
 * não final. `environment` restringe ao ambiente em que a transmissão nasceu;
 * omitido = qualquer ambiente (DELETE da habilitação).
 */
export async function countLiveServiceTransmissions(
  q: Q, schemaName: string, institutionId: number, environment?: IssuerEnvironment
): Promise<number> {
  const s = assertSchema(schemaName)
  const finals = [...FINAL_TRANSMISSION_KINDS].map(k => `'${k}'`).join(',')
  const [rows] = await q.query<any[]>(
    `SELECT COUNT(*) AS n
       FROM \`${s}\`.tb_invoice_service_transmission t
       LEFT JOIN \`${s}\`.tb_invoice_service_transmission_event le
         ON le.tb_institution_id = t.tb_institution_id AND le.tb_invoice_id = t.tb_invoice_id
        AND le.terminal = t.terminal AND le.attempt = t.attempt AND le.deleted = 'N'
        AND le.event = (SELECT MAX(x.event) FROM \`${s}\`.tb_invoice_service_transmission_event x
                         WHERE x.tb_institution_id = t.tb_institution_id AND x.tb_invoice_id = t.tb_invoice_id
                           AND x.terminal = t.terminal AND x.attempt = t.attempt AND x.deleted = 'N')
      WHERE t.tb_institution_id = ? AND t.deleted = 'N'
        AND (? IS NULL OR t.environment = ?)
        AND (le.kind IS NULL OR le.kind NOT IN (${finals}))`,
    [institutionId, environment ?? null, environment ?? null]
  )
  return Number(rows?.[0]?.n ?? 0)
}
