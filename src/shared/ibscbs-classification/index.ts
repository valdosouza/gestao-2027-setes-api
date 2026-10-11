import pool from '@shared/db/connection'
import { HttpError, FieldError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { escapeLike } from '@shared/list'

/**
 * Peça @shared/ibscbs-classification — RESOLUÇÃO da classificação IBS/CBS (fase IBS/CBS,
 * prompt_fase_ibs_cbs.md §3 conceito 12; D-IB6/D-IB9/D-IB22/D-IB23/D-IB29 + A-IB1).
 * Fonte: catálogo CENTRAL carregado pela rotina do Super (@shared/ibscbs-catalog):
 *   identidade tb_tax_ibscbs_classification · história ..._validity (vigência = a linha) ·
 *   presença por modelo ..._applicability · cIndOp tb_ibscbs_place_indicator(+_applicability) · tb_nbs.
 * Regras desta peça (a ÚNICA que decide — o cadastro do serviço hoje; o congelamento do
 * faturamento na IB-2):
 *   - DATA DO FATO (`findClassificationAt`): a linha vigente na data (valid_from ≤ data ≤
 *     valid_until) — CST = prefixo, nunca guardado. É a que o congelamento da IB-2 usa;
 *   - CADASTRO (D-IB29 — `pickForRegistration`, a regra ÚNICA de lista, salvar e exibição):
 *     entre as linhas vigentes HOJE e, antes da obrigação da NFS-e do Simples
 *     (NFSE_IBSCBS_SIMPLES_OBLIGATION_START), as que começam até ela, vale a que tem PRESENÇA
 *     no modelo (vigente mais nova; senão futura mais próxima); sem presença em nenhuma, a
 *     vigente mais nova (para o 422 dizer "não aceito") — lista e salvar nunca discordam;
 *   - só é aceita no documento se a linha tem PRESENÇA para o modelo (SE = NFS-e);
 *     código ainda não confirmado pela Calculadora não tem presença (A-IB1);
 *   - classificação que EXIGE tributação regular é recusada: o builder não emite gTribRegular
 *     (parecer do guardião §10.3 (a.ii));
 *   - cIndOp precisa de presença para o modelo (Anexo VII);
 *   - D-IB36: linha SUPERADA (ausente da fonte desde uma versão — `absent_since_version`) é
 *     ignorada em toda resolução; a exibição de um código gravado só a mostra se não houver outra;
 *   - D-IB37: `classificationAcceptedToday` diz se a classificação gravada é aceita HOJE pela
 *     regra do cadastro (o GET devolve e a tela mostra um selo quando não é).
 * Não calcula nada (o fisco calcula — §1.2) e não conhece ERP: recebe códigos e uma data.
 */

export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> }

/** Modelo da NFS-e no domínio de tb_invoice.model (D-E1). */
export const MODEL_NFSE = 'SE' as const
export type FiscalModel = 'SE' | '55' | '65'

/** Início da obrigação do grupo IBS/CBS na NFS-e do OPTANTE DO SIMPLES — competência 01/2027
 *  (Ato Conjunto RFB/CGIBS nº 4/2026 § 1º; o não optante tem outra data — Q-IB35). Limite da
 *  janela de vigência futura do cadastro (D-IB29); a obrigação por documento × regime × data é
 *  da IB-2 (D-IB8), lida pelo enquadramento datado. */
export const NFSE_IBSCBS_SIMPLES_OBLIGATION_START = '2027-01-01'

export const deriveCst = (classificationCode: string): string => classificationCode.slice(0, 3)

export interface ClassificationAt {
  code:                    string
  cst:                     string
  name:                    string
  validFrom:               string
  validUntil:              string | null
  requiresRegularTaxation: boolean
  /** Presença para o modelo pedido na linha. */
  applicable:              boolean
  /** D-IB36: a linha sumiu da fonte (ausente desde uma versão do IT) — nunca é escolhida. */
  superseded:              boolean
}

const dateStr = (v: any): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)

const CLASSIFICATION_SELECT =
  `SELECT v.code, c.tb_tax_ibscbs_id AS cst, v.name, v.valid_from AS validFrom, v.valid_until AS validUntil,
          v.requires_regular_taxation AS requiresRegular, v.absent_since_version AS absentSince,
          (a.code IS NOT NULL) AS applicable
     FROM setes_central.tb_tax_ibscbs_classification_validity v
     JOIN setes_central.tb_tax_ibscbs_classification c ON c.code = v.code AND c.deleted = 'N'
     LEFT JOIN setes_central.tb_tax_ibscbs_classification_applicability a
       ON a.code = v.code AND a.valid_from = v.valid_from AND a.model = ? AND a.deleted = 'N'`

const toClassification = (r: any): ClassificationAt => ({
  code: r.code, cst: r.cst, name: r.name,
  validFrom: dateStr(r.validFrom) ?? '', validUntil: dateStr(r.validUntil),
  requiresRegularTaxation: r.requiresRegular === 'S',
  applicable: Number(r.applicable) === 1,
  superseded: r.absentSince != null,
})

/**
 * DATA DO FATO: linha vigente do cClassTrib na data + presença para o modelo. null = inexistente/fora de vigência.
 * `applicable = false` (linha vigente SEM presença no modelo) NÃO é null: quem fatura (IB-2) segue o caminho da
 * D-IB34 pela D-IB41 — antes da obrigação a nota sai sem o grupo IBS/CBS; depois, o 422 da D-IB8. Nunca tratar
 * como "sem classificação" nem consultar a regra do cadastro (`acceptedToday` não decide o faturamento).
 */
export async function findClassificationAt(
  q: Queryable, code: string, model: FiscalModel, date: string,
): Promise<ClassificationAt | null> {
  const [rows] = await q.query(
    `${CLASSIFICATION_SELECT}
      WHERE v.code = ? AND v.deleted = 'N' AND v.absent_since_version IS NULL
        AND v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until >= ?)
      ORDER BY v.valid_from DESC
      LIMIT 1`,
    [model, code, date, date])
  return rows[0] ? toClassification(rows[0]) : null
}

/** Fim da janela de vigência futura aceita no cadastro (D-IB29): a obrigação; depois dela, nenhuma. */
export const registrationWindowEnd = (today: string): string | null =>
  today < NFSE_IBSCBS_SIMPLES_OBLIGATION_START ? NFSE_IBSCBS_SIMPLES_OBLIGATION_START : null

/**
 * CADASTRO (D-IB29) — a regra ÚNICA de qual linha de um código vale para lista, salvar e exibição.
 * Candidatas: as vigentes hoje e, antes da obrigação, as que começam até ela. Preferência: vigente
 * COM presença (mais nova) → futura COM presença (mais próxima) → vigente sem presença (mais nova)
 * → futura sem presença. null = nenhuma candidata (inexistente, vencida ou começa depois da obrigação).
 */
export function pickForRegistration(rows: readonly ClassificationAt[], today: string): ClassificationAt | null {
  const end = registrationWindowEnd(today)
  rows = rows.filter(r => !r.superseded)   // D-IB36: linha que sumiu da fonte nunca é escolhida
  const current = rows.filter(r => r.validFrom <= today && (r.validUntil === null || r.validUntil >= today))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
  const future = end === null ? [] : rows.filter(r => r.validFrom > today && r.validFrom <= end)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
  return current.find(r => r.applicable) ?? future.find(r => r.applicable) ?? current[0] ?? future[0] ?? null
}

async function rowsOfCode(q: Queryable, code: string, model: FiscalModel): Promise<ClassificationAt[]> {
  const [rows] = await q.query(
    `${CLASSIFICATION_SELECT}
      WHERE v.code = ? AND v.deleted = 'N'
      ORDER BY v.valid_from`,
    [model, code])
  return (rows as any[]).map(toClassification)
}

/** CADASTRO: a linha que `pickForRegistration` escolhe para o código (presença e flag inclusas). */
export async function findClassificationForRegistration(
  q: Queryable, code: string, model: FiscalModel, today: string,
): Promise<ClassificationAt | null> {
  return pickForRegistration(await rowsOfCode(q, code, model), today)
}

/** EXIBIÇÃO no cadastro (nome + vigência): a linha do cadastro (mesma regra); sem candidata, a
 *  futura mais próxima ou a mais recente — o GET nunca esconde o que está gravado. Sem data
 *  (`today` null), a mais recente. */
export async function classificationForDisplay(
  q: Queryable, code: string, today: string | null, model: FiscalModel = MODEL_NFSE,
): Promise<{ name: string; validFrom: string; validUntil: string | null } | null> {
  const all = await rowsOfCode(q, code, model)
  const live = all.filter(r => !r.superseded)
  // D-IB36: a linha superada só aparece se NÃO houver outra (reservas olham primeiro as não superadas)
  const latestOf = (rows: ClassificationAt[]) => [...rows].sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]
  const nextOf = (rows: ClassificationAt[], d: string) =>
    rows.filter(r => r.validFrom > d).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0]
  const shown = today === null
    ? latestOf(live) ?? latestOf(all)
    : pickForRegistration(all, today) ?? nextOf(live, today) ?? latestOf(live) ?? latestOf(all)
  return shown ? { name: shown.name, validFrom: shown.validFrom, validUntil: shown.validUntil } : null
}

/** D-IB37: a classificação GRAVADA é aceita hoje pela regra do cadastro? — POR COMPONENTE (o selo da
 *  tela aponta o código certo: gate socrático da Rodada 4). É sinal de CADASTRO, não decide o faturamento
 *  (a IB-2 resolve pela data do fato e a nota congelada nunca reconsulta o catálogo). */
export async function classificationAcceptance(
  q: Queryable, classificationCode: string, placeIndicatorCode: string, today: string,
  model: FiscalModel = MODEL_NFSE,
): Promise<{ classification: boolean; placeIndicator: boolean }> {
  const cls = await findClassificationForRegistration(q, classificationCode, model, today)
  const place = await findPlaceIndicator(q, placeIndicatorCode, model)
  return {
    classification: !!cls && cls.applicable && !cls.requiresRegularTaxation,
    placeIndicator: !!place && place.applicable,
  }
}

/** D-IB37: os DOIS códigos aceitos hoje (o par inteiro). */
export async function classificationAcceptedToday(
  q: Queryable, classificationCode: string, placeIndicatorCode: string, today: string,
  model: FiscalModel = MODEL_NFSE,
): Promise<boolean> {
  const a = await classificationAcceptance(q, classificationCode, placeIndicatorCode, today, model)
  return a.classification && a.placeIndicator
}

/** Boot (gate socrático da Rodada 4 — molde D-IB26/D-F45): o que a peça presume do catálogo central
 *  EXISTE. Sem o script sql/63 a coluna `absent_since_version` falta e o cadastro de serviços daria
 *  500 com o boot limpo — agora a API não sobe e diz qual script aplicar. */
export async function assertIbscbsCatalogSchema(q: Queryable = pool): Promise<string> {
  try {
    await q.query(`SELECT absent_since_version FROM setes_central.tb_tax_ibscbs_classification_validity LIMIT 0`)
  } catch (err: any) {
    if (err?.errno === 1054 || err?.code === 'ER_BAD_FIELD_ERROR') {
      throw new Error('Catálogo IBS/CBS sem a coluna absent_since_version — aplique o script sql/63_ibscbs_validity_absent_since.sql em setes_central ANTES do setes-api (D-IB36)')
    }
    throw err
  }
  return 'ok'
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

/**
 * D-IB40: a regra ÚNICA de "NBS aceita" — presente na lista oficial (`deleted = 'N'` no catálogo
 * central). O cadastro (nbsExists), a lista de apoio, o selo do GET e a IB-2 leem por aqui; ninguém
 * repete o predicado. `alias` = o alias de setes_central.tb_nbs na consulta de quem chama — num LEFT
 * JOIN, o JOIN NÃO filtra `deleted` (a descrição da NBS que saiu da lista segue exibida) e o
 * predicado decide no SELECT; sem linha no catálogo = não aceita.
 */
export function nbsAcceptedSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`alias inválido para tb_nbs: ${alias}`)
  return `(${alias}.code IS NOT NULL AND ${alias}.deleted = 'N')`
}

export async function nbsExists(q: Queryable, code: string): Promise<boolean> {
  const [rows] = await q.query(
    `SELECT 1 FROM setes_central.tb_nbs nb WHERE nb.code = ? AND ${nbsAcceptedSql('nb')}`, [code])
  return rows.length > 0
}

export interface ServiceClassificationInput {
  /** undefined = não mexe (ou não mudou — D-IB30); null = sem NBS. */
  nbs?:    string | null
  /** undefined = não mexe (ou não mudou — D-IB30); null = sem classificação; objeto = classificação escolhida. */
  ibscbs?: { classificationCode: string; placeIndicatorCode: string } | null
}

/**
 * Confere o que o SERVIÇO presume (D-IB6) para o modelo NFS-e, na data informada
 * (hoje do estabelecimento — PADROES §10) pela regra do CADASTRO (D-IB29). Junta TODAS as
 * pendências e lança UM 422 com fields[] (o campo da tela fica marcado). Nada a conferir =
 * retorna sem consulta. Quem chama passa só o que MUDOU (D-IB30) — e, no par, `checks` diz qual
 * dos dois códigos mudou (trocar só o cIndOp não reconfere o cClassTrib inalterado — gate adversarial).
 */
export async function assertServiceClassification(
  q: Queryable, input: ServiceClassificationInput, date: string, model: FiscalModel = MODEL_NFSE,
  checks: { classification: boolean; placeIndicator: boolean } = { classification: true, placeIndicator: true },
): Promise<void> {
  const fields: FieldError[] = []
  let code: string | undefined

  if (input.nbs != null && !(await nbsExists(q, input.nbs))) {
    // mesma regra do selo (D-IB40): inexistente ou retirada da lista = "não está na lista oficial"
    fields.push({ field: 'nbs', message: `NBS ${input.nbs} não está na lista oficial` })
    code ??= ErrorCodes.IBSCBS_NBS_NOT_FOUND
  }

  if (input.ibscbs != null) {
    const { classificationCode, placeIndicatorCode } = input.ibscbs
    const cls = checks.classification ? await findClassificationForRegistration(q, classificationCode, model, date) : undefined
    if (cls === undefined) {
      // cClassTrib inalterado (D-IB30): não reconfere
    } else if (!cls) {
      const end = registrationWindowEnd(date)
      fields.push({
        field: 'ibscbs.classificationCode',
        message: `cClassTrib ${classificationCode} inexistente ou fora de vigência em ${date}`
          + (end ? ` (nem começa até ${end})` : ''),
      })
      code ??= ErrorCodes.IBSCBS_CLASSIFICATION_NOT_FOUND
    } else if (!cls.applicable) {
      fields.push({ field: 'ibscbs.classificationCode', message: `cClassTrib ${classificationCode} não é aceito na NFS-e (ou ainda não foi confirmado pela Calculadora oficial)` })
      code ??= ErrorCodes.IBSCBS_CLASSIFICATION_NOT_APPLICABLE
    } else if (cls.requiresRegularTaxation) {
      fields.push({ field: 'ibscbs.classificationCode', message: `cClassTrib ${classificationCode} exige o grupo de tributação regular, que ainda não é emitido` })
      code ??= ErrorCodes.IBSCBS_CLASSIFICATION_REQUIRES_REGULAR
    }
    const place = checks.placeIndicator ? await findPlaceIndicator(q, placeIndicatorCode, model) : undefined
    if (place !== undefined && (!place || !place.applicable)) {
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

export interface CodeLookupRow {
  code:        string
  description: string
  /** Só nas classificações (D-IB29): vigência da linha oferecida — a TELA traduz "vale a partir de". */
  validFrom?:  string
  validUntil?: string | null
}

/**
 * cClassTrib que o CADASTRO aceita hoje (D-IB29 — mesma regra do salvar: `pickForRegistration`),
 * aceitos no modelo e que não exigem tributação regular. Um código por linha; a vigência vai em
 * validFrom/validUntil (texto para o usuário é da tela — i18n).
 */
export async function listClassificationsLookup(
  filter: string, date: string, model: FiscalModel = MODEL_NFSE, q: Queryable = pool,
): Promise<CodeLookupRow[]> {
  const like = filter ? `%${escapeLike(filter)}%` : null
  const end = registrationWindowEnd(date) ?? date   // depois da obrigação a janela futura é vazia
  const [rows] = await q.query(
    `${CLASSIFICATION_SELECT}
      WHERE v.deleted = 'N' AND v.absent_since_version IS NULL
        AND ((v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until >= ?))
             OR (v.valid_from > ? AND v.valid_from <= ?))
        AND (? IS NULL OR v.code LIKE ? OR v.name LIKE ?)
      ORDER BY v.code, v.valid_from
      LIMIT 400`,
    [model, date, date, date, end, like, like, like])
  const byCode = new Map<string, ClassificationAt[]>()
  for (const r of rows as any[]) {
    const c = toClassification(r)
    byCode.set(c.code, [...(byCode.get(c.code) ?? []), c])
  }
  const out: CodeLookupRow[] = []
  for (const list of byCode.values()) {
    const picked = pickForRegistration(list, date)
    if (!picked || !picked.applicable || picked.requiresRegularTaxation) continue
    out.push({
      code: picked.code, description: `${picked.cst} · ${picked.code} — ${picked.name}`,
      validFrom: picked.validFrom, validUntil: picked.validUntil,
    })
    if (out.length === 100) break
  }
  return out
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
    `SELECT nb.code, CONCAT(nb.code, ' — ', nb.description) AS description
       FROM setes_central.tb_nbs nb
      WHERE ${nbsAcceptedSql('nb')} AND (? IS NULL OR nb.description LIKE ? OR (? IS NOT NULL AND nb.code LIKE ?))
      ORDER BY nb.code
      LIMIT 100`,
    [like, like, codeLike, codeLike])
  return rows
}
