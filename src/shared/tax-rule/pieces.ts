import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'
import {
  TaxRulePieces, IcmsPiece, IcmsStPiece, IpiPiece, PisCofinsPiece, IiPiece,
} from './types'

/**
 * Peças 1:1 da regra — leitura e escrita TRANSACTION-AWARE (recebem conn).
 * PRESENÇA = incidência: salvar sincroniza (soft-delete geral + upsert das
 * presentes — padrão syncInterfaces do módulo modules); a leitura só devolve
 * as vivas. Decisões 1/23 do prompt da fase.
 */

export async function loadPieces(
  schemaName: string, ruleId: number
): Promise<TaxRulePieces> {
  const s = assertSchema(schemaName)
  const pieces: TaxRulePieces = {}

  const [icms] = await pool.query<any[]>(
    `SELECT tb_tax_icms_nr_id AS cstNr, tb_tax_icms_sn_id AS csosn,
            tb_deter_base_tax_icms_id AS modBc, tb_discharge_icms_id AS dischargeId,
            aliq, aliq_reduction AS aliqReduction, base_reduction AS baseReduction,
            deferred, deferred_aliq AS deferredAliq, highlight
       FROM \`${s}\`.tb_tax_rule_icms WHERE id = ? AND deleted = 'N'`, [ruleId])
  if (icms[0]) pieces.icms = icms[0] as IcmsPiece

  const [st] = await pool.query<any[]>(
    `SELECT tb_deter_base_tax_icms_st_id AS modBcSt,
            propagate_base_reduction AS propagateBaseReduction
       FROM \`${s}\`.tb_tax_rule_icms_st WHERE id = ? AND deleted = 'N'`, [ruleId])
  if (st[0]) pieces.icmsSt = st[0] as IcmsStPiece

  const [ipi] = await pool.query<any[]>(
    `SELECT tb_tax_ipi_id AS cst, aliq
       FROM \`${s}\`.tb_tax_rule_ipi WHERE id = ? AND deleted = 'N'`, [ruleId])
  if (ipi[0]) pieces.ipi = ipi[0] as IpiPiece

  const [pc] = await pool.query<any[]>(
    `SELECT kind, cst, aliq
       FROM \`${s}\`.tb_tax_rule_pis_cofins
      WHERE id = ? AND deleted = 'N' ORDER BY kind`, [ruleId])
  if (pc.length) pieces.pisCofins = pc as PisCofinsPiece[]

  const [ii] = await pool.query<any[]>(
    `SELECT ii_aliq AS iiAliq, irpj_aliq AS irpjAliq, csll_aliq AS csllAliq,
            afrmm_aliq AS afrmmAliq, siscomex_aliq AS siscomexAliq
       FROM \`${s}\`.tb_tax_rule_ii WHERE id = ? AND deleted = 'N'`, [ruleId])
  if (ii[0]) pieces.ii = ii[0] as IiPiece

  return pieces
}

/**
 * Sincroniza as peças DENTRO da transação do chamador: soft-delete geral +
 * upsert das presentes (ON DUPLICATE ressuscita — presença = incidência).
 */
export async function savePieces(
  conn: any, schemaName: string, ruleId: number, p: TaxRulePieces
): Promise<void> {
  const s = assertSchema(schemaName)
  for (const t of ['tb_tax_rule_icms', 'tb_tax_rule_icms_st', 'tb_tax_rule_ipi',
                   'tb_tax_rule_pis_cofins', 'tb_tax_rule_ii']) {
    await conn.query(
      `UPDATE \`${s}\`.${t} SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [ruleId])
  }

  if (p.icms) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_tax_rule_icms
         (id, tb_tax_icms_nr_id, tb_tax_icms_sn_id, tb_deter_base_tax_icms_id,
          tb_discharge_icms_id, aliq, aliq_reduction, base_reduction,
          deferred, deferred_aliq, highlight, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         tb_tax_icms_nr_id = VALUES(tb_tax_icms_nr_id),
         tb_tax_icms_sn_id = VALUES(tb_tax_icms_sn_id),
         tb_deter_base_tax_icms_id = VALUES(tb_deter_base_tax_icms_id),
         tb_discharge_icms_id = VALUES(tb_discharge_icms_id),
         aliq = VALUES(aliq), aliq_reduction = VALUES(aliq_reduction),
         base_reduction = VALUES(base_reduction), deferred = VALUES(deferred),
         deferred_aliq = VALUES(deferred_aliq), highlight = VALUES(highlight),
         deleted = 'N', updated_at = NOW()`,
      [ruleId, p.icms.cstNr ?? null, p.icms.csosn ?? null, p.icms.modBc ?? null,
       p.icms.dischargeId ?? null, p.icms.aliq ?? null,
       p.icms.aliqReduction ?? null, p.icms.baseReduction ?? null,
       p.icms.deferred ?? 'N', p.icms.deferredAliq ?? null,
       p.icms.highlight ?? 'N'])
  }

  if (p.icmsSt) {
    if (!p.icms) {
      // ST sem ICMS próprio não existe no domínio (o delta do ST precisa do
      // próprio — §P3.3 do mapeamento).
      throw new HttpError(422, 'Peça ICMS-ST exige a peça ICMS',
        [{ field: 'icmsSt', message: 'Informe também o ICMS próprio' }])
    }
    await conn.query(
      `INSERT INTO \`${s}\`.tb_tax_rule_icms_st
         (id, tb_deter_base_tax_icms_st_id, propagate_base_reduction,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         tb_deter_base_tax_icms_st_id = VALUES(tb_deter_base_tax_icms_st_id),
         propagate_base_reduction = VALUES(propagate_base_reduction),
         deleted = 'N', updated_at = NOW()`,
      [ruleId, p.icmsSt.modBcSt ?? null,
       p.icmsSt.propagateBaseReduction ?? 'N'])
  }

  if (p.ipi) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_tax_rule_ipi
         (id, tb_tax_ipi_id, aliq, created_at, updated_at, deleted)
       VALUES (?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         tb_tax_ipi_id = VALUES(tb_tax_ipi_id), aliq = VALUES(aliq),
         deleted = 'N', updated_at = NOW()`,
      [ruleId, p.ipi.cst, p.ipi.aliq ?? null])
  }

  for (const pc of p.pisCofins ?? []) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_tax_rule_pis_cofins
         (id, kind, cst, aliq, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         cst = VALUES(cst), aliq = VALUES(aliq),
         deleted = 'N', updated_at = NOW()`,
      [ruleId, pc.kind, pc.cst, pc.aliq ?? null])
  }

  if (p.ii) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_tax_rule_ii
         (id, ii_aliq, irpj_aliq, csll_aliq, afrmm_aliq, siscomex_aliq,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         ii_aliq = VALUES(ii_aliq), irpj_aliq = VALUES(irpj_aliq),
         csll_aliq = VALUES(csll_aliq), afrmm_aliq = VALUES(afrmm_aliq),
         siscomex_aliq = VALUES(siscomex_aliq),
         deleted = 'N', updated_at = NOW()`,
      [ruleId, p.ii.iiAliq ?? null, p.ii.irpjAliq ?? null,
       p.ii.csllAliq ?? null, p.ii.afrmmAliq ?? null,
       p.ii.siscomexAliq ?? null])
  }
}

/**
 * Valida os códigos de CST/modBC/CFOP contra os CATÁLOGOS CENTRAIS
 * (decisão 33: sem FK física em coluna string — a integridade é desta peça).
 * Devolve a lista de campos inválidos (vazia = ok).
 */
export async function findInvalidCatalogCodes(
  p: TaxRulePieces,
  selector?: { cfopId?: string | null; direction?: 'E' | 'S' }
): Promise<{ field: string; message: string }[]> {
  const invalid: { field: string; message: string }[] = []
  const check = async (table: string, code: string | null | undefined,
                       field: string) => {
    if (!code) return
    const [rows] = await pool.query<any[]>(
      `SELECT id FROM setes_central.\`${table}\` WHERE id = ? AND deleted = 'N'`,
      [code])
    if (!rows[0]) invalid.push({ field, message: `Código '${code}' não existe em ${table}` })
  }
  if (selector?.cfopId) {
    // Decisão 35: CFOP não existe sem way, e o way da natureza tem que
    // CONCORDAR com o sentido da regra — CFOP do sentido oposto = regra
    // morta (o motor filtra direction E cfop; nunca casaria).
    const [rows] = await pool.query<any[]>(
      `SELECT id, way FROM setes_central.tb_cfop WHERE id = ? AND deleted = 'N'`,
      [selector.cfopId])
    if (!rows[0]) {
      invalid.push({ field: 'selector.cfopId',
        message: `Código '${selector.cfopId}' não existe em tb_cfop` })
    } else if (rows[0].way !== 'E' && rows[0].way !== 'S') {
      invalid.push({ field: 'selector.cfopId',
        message: `CFOP '${selector.cfopId}' sem sentido (way) no catálogo` })
    } else if (selector.direction && rows[0].way !== selector.direction) {
      invalid.push({ field: 'selector.cfopId',
        message: `CFOP '${selector.cfopId}' é de ${rows[0].way === 'E'
          ? 'entrada' : 'saída'} — contradiz o sentido da regra` })
    }
  }
  if (p.icms) {
    await check('tb_tax_icms_nr', p.icms.cstNr, 'icms.cstNr')
    await check('tb_tax_icms_sn', p.icms.csosn, 'icms.csosn')
    await check('tb_deter_base_tax_icms', p.icms.modBc, 'icms.modBc')
  }
  if (p.icmsSt) {
    await check('tb_deter_base_tax_icms_st', p.icmsSt.modBcSt, 'icmsSt.modBcSt')
  }
  if (p.ipi) await check('tb_tax_ipi', p.ipi.cst, 'ipi.cst')
  for (const pc of p.pisCofins ?? []) {
    await check(pc.kind === 'P' ? 'tb_tax_pis' : 'tb_tax_cofins',
                pc.cst, `pisCofins.${pc.kind}.cst`)
  }
  return invalid
}
