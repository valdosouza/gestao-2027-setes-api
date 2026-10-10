import pool from '@shared/db/connection'
import { HttpError, FieldError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { escapeLike } from '@shared/list'

/**
 * Peça @shared/ibscbs-classification — RESOLUÇÃO da classificação IBS/CBS (fase IBS/CBS,
 * prompt_fase_ibs_cbs.md §3 conceito 12; D-IB6/D-IB9/D-IB22/D-IB23 + A-IB1).
 * Fonte: catálogo CENTRAL carregado pela rotina do Super (@shared/ibscbs-catalog):
 *   identidade tb_tax_ibscbs_classification · história ..._validity (vigência = a linha) ·
 *   presença por modelo ..._applicability · cIndOp tb_ibscbs_place_indicator(+_applicability) · tb_nbs.
 * Regras desta peça (a ÚNICA que decide — o cadastro do serviço hoje; o congelamento do
 * faturamento na IB-2):
 *   - classificação vale na DATA do fato (valid_from ≤ data ≤ valid_until) — CST = prefixo, nunca guardado;
 *   - só é aceita no documento se a linha vigente tem PRESENÇA para o modelo (SE = NFS-e);
 *     código ainda não confirmado pela Calculadora não tem presença (A-IB1);
 *   - classificação que EXIGE tributação regular é recusada: o builder não emite gTribRegular
 *     (parecer do guardião §10.3 (a.ii));
 *   - cIndOp precisa de presença para o modelo (Anexo VII).
 * Não calcula nada (o fisco calcula — §1.2) e não conhece ERP: recebe códigos e uma data.
 */

export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> }

/** Modelo da NFS-e no domínio de tb_invoice.model (D-E1). */
export const MODEL_NFSE = 'SE' as const
export type FiscalModel = 'SE' | '55' | '65'

export const deriveCst = (classificationCode: string): string => classificationCode.slice(0, 3)

export interface ClassificationAt {
  code:                    string
  cst:                     string
  name:                    string
  validFrom:               string
  validUntil:              string | null
  requiresRegularTaxation: boolean
  /** Presença para o modelo pedido na linha vigente. */
  applicable:              boolean
}

const dateStr = (v: any): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)

/** Linha vigente do cClassTrib na data + presença para o modelo. null = inexistente/fora de vigência. */
export async function findClassificationAt(
  q: Queryable, code: string, model: FiscalModel, date: string,
): Promise<ClassificationAt | null> {
  const [rows] = await q.query(
    `SELECT v.code, c.tb_tax_ibscbs_id AS cst, v.name, v.valid_from AS validFrom, v.valid_until AS validUntil,
            v.requires_regular_taxation AS requiresRegular,
            (a.code IS NOT NULL) AS applicable
       FROM setes_central.tb_tax_ibscbs_classification_validity v
       JOIN setes_central.tb_tax_ibscbs_classification c ON c.code = v.code AND c.deleted = 'N'
       LEFT JOIN setes_central.tb_tax_ibscbs_classification_applicability a
         ON a.code = v.code AND a.valid_from = v.valid_from AND a.model = ? AND a.deleted = 'N'
      WHERE v.code = ? AND v.deleted = 'N'
        AND v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until >= ?)
      ORDER BY v.valid_from DESC
      LIMIT 1`,
    [model, code, date, date])
  const r = rows[0]
  if (!r) return null
  return {
    code: r.code, cst: r.cst, name: r.name,
    validFrom: dateStr(r.validFrom) ?? '', validUntil: dateStr(r.validUntil),
    requiresRegularTaxation: r.requiresRegular === 'S',
    applicable: Number(r.applicable) === 1,
  }
}

export async function findPlaceIndicator(
  q: Queryable, code: string, model: FiscalModel,
): Promise<{ code: string; description: string; applicable: boolean } | null> {
  const [rows] = await q.query(
    `SELECT p.code, p.description, (a.code IS NOT NULL) AS applicable
       FROM setes_central.tb_ibscbs_place_indicator p
       LEFT JOIN setes_central.tb_ibscbs_place_indicator_applicability a
         ON a.code = p.code AND a.model = ? AND a.deleted = 'N'
      WHERE p.code = ? AND p.deleted = 'N'`,
    [model, code])
  const r = rows[0]
  return r ? { code: r.code, description: r.description, applicable: Number(r.applicable) === 1 } : null
}

export async function nbsExists(q: Queryable, code: string): Promise<boolean> {
  const [rows] = await q.query(`SELECT 1 FROM setes_central.tb_nbs WHERE code = ? AND deleted = 'N'`, [code])
  return rows.length > 0
}

export interface ServiceClassificationInput {
  /** undefined = não mexe; null = sem NBS. */
  nbs?:    string | null
  /** undefined = não mexe; null = sem classificação; objeto = classificação escolhida. */
  ibscbs?: { classificationCode: string; placeIndicatorCode: string } | null
}

/**
 * Confere o que o SERVIÇO presume (D-IB6) para o modelo NFS-e, na data informada
 * (hoje do estabelecimento — PADROES §10). Junta TODAS as pendências e lança UM 422
 * com fields[] (o campo da tela fica marcado). Nada a conferir = retorna sem consulta.
 */
export async function assertServiceClassification(
  q: Queryable, input: ServiceClassificationInput, date: string, model: FiscalModel = MODEL_NFSE,
): Promise<void> {
  const fields: FieldError[] = []
  let code: string | undefined

  if (input.nbs != null && !(await nbsExists(q, input.nbs))) {
    fields.push({ field: 'nbs', message: `NBS ${input.nbs} não existe no catálogo oficial` })
    code ??= ErrorCodes.IBSCBS_NBS_NOT_FOUND
  }

  if (input.ibscbs != null) {
    const { classificationCode, placeIndicatorCode } = input.ibscbs
    const cls = await findClassificationAt(q, classificationCode, model, date)
    if (!cls) {
      fields.push({ field: 'ibscbs.classificationCode', message: `cClassTrib ${classificationCode} inexistente ou fora de vigência em ${date}` })
      code ??= ErrorCodes.IBSCBS_CLASSIFICATION_NOT_FOUND
    } else if (!cls.applicable) {
      fields.push({ field: 'ibscbs.classificationCode', message: `cClassTrib ${classificationCode} não é aceito na NFS-e (ou ainda não foi confirmado pela Calculadora oficial)` })
      code ??= ErrorCodes.IBSCBS_CLASSIFICATION_NOT_APPLICABLE
    } else if (cls.requiresRegularTaxation) {
      fields.push({ field: 'ibscbs.classificationCode', message: `cClassTrib ${classificationCode} exige o grupo de tributação regular, que ainda não é emitido` })
      code ??= ErrorCodes.IBSCBS_CLASSIFICATION_REQUIRES_REGULAR
    }
    const place = await findPlaceIndicator(q, placeIndicatorCode, model)
    if (!place || !place.applicable) {
      fields.push({ field: 'ibscbs.placeIndicatorCode', message: `cIndOp ${placeIndicatorCode} inexistente ou não aceito na NFS-e` })
      code ??= ErrorCodes.IBSCBS_PLACE_INDICATOR_INVALID
    }
  }

  if (fields.length) {
    throw new HttpError(422, 'Classificação IBS/CBS do serviço inválida', fields, code)
  }
}

// ---------------------------------------------------------------------------
// Listas de apoio do formulário (catálogo central, LIMIT 100, escapeLike)
// ---------------------------------------------------------------------------

export interface CodeLookupRow { code: string; description: string }

/** cClassTrib VIGENTES na data, aceitos no modelo e que não exigem tributação regular. */
export async function listClassificationsLookup(
  filter: string, date: string, model: FiscalModel = MODEL_NFSE, q: Queryable = pool,
): Promise<CodeLookupRow[]> {
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await q.query(
    `SELECT v.code, CONCAT(c.tb_tax_ibscbs_id, ' · ', v.code, ' — ', v.name) AS description
       FROM setes_central.tb_tax_ibscbs_classification_validity v
       JOIN setes_central.tb_tax_ibscbs_classification c ON c.code = v.code AND c.deleted = 'N'
       JOIN setes_central.tb_tax_ibscbs_classification_applicability a
         ON a.code = v.code AND a.valid_from = v.valid_from AND a.model = ? AND a.deleted = 'N'
      WHERE v.deleted = 'N' AND v.requires_regular_taxation = 'N'
        AND v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until >= ?)
        AND (? IS NULL OR v.code LIKE ? OR v.name LIKE ?)
      ORDER BY v.code
      LIMIT 100`,
    [model, date, date, like, like, like])
  return rows
}

/** cIndOp aceitos no modelo (Anexo VII). */
export async function listPlaceIndicatorsLookup(
  filter: string, model: FiscalModel = MODEL_NFSE, q: Queryable = pool,
): Promise<CodeLookupRow[]> {
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await q.query(
    `SELECT p.code, CONCAT(p.code, ' — ', p.description) AS description
       FROM setes_central.tb_ibscbs_place_indicator p
       JOIN setes_central.tb_ibscbs_place_indicator_applicability a
         ON a.code = p.code AND a.model = ? AND a.deleted = 'N'
      WHERE p.deleted = 'N' AND (? IS NULL OR p.code LIKE ? OR p.description LIKE ?)
      ORDER BY p.code
      LIMIT 100`,
    [model, like, like, like])
  return rows
}

/** NBS do catálogo oficial (código sem pontos ou parte da descrição). */
export async function listNbsLookup(filter: string, q: Queryable = pool): Promise<CodeLookupRow[]> {
  const digits = filter.replace(/\D/g, '')
  const like = filter ? `%${escapeLike(filter)}%` : null
  const codeLike = digits ? `${digits}%` : null
  const [rows] = await q.query(
    `SELECT code, CONCAT(code, ' — ', description) AS description
       FROM setes_central.tb_nbs
      WHERE deleted = 'N' AND (? IS NULL OR description LIKE ? OR (? IS NOT NULL AND code LIKE ?))
      ORDER BY code
      LIMIT 100`,
    [like, like, codeLike, codeLike])
  return rows
}
