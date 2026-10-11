import type { Connection, PoolConnection } from 'mysql2/promise'
import { CatalogSourceError, ClassificationRecord, ItCatalog, NbsRecord, PlaceIndicatorRecord } from './parse'

/**
 * Gravação do catálogo IBS/CBS em setes_central (IB-1 — D-IB5/D-IB22/D-IB23/D-IB26).
 * UMA transação: tudo ou nada. Sessão em STRICT_ALL_TABLES (o dev roda sem modo estrito —
 * PADROES §5; a validação do parse.ts é a guarda principal, o modo estrito é o cinto).
 * `apply: false` = ensaio: executa tudo e faz ROLLBACK (contagens exatas, nada gravado).
 *
 * Regras de escrita:
 *  - linha de VIGÊNCIA nunca é apagada (nota antiga aponta código antigo); atributo
 *    corrigido sem dIniVig novo = UPDATE da mesma linha (source_* registram a origem);
 *  - APLICABILIDADE é presença: só os modelos em `models` são gerenciados (a carga da IB-1
 *    gerencia só 'SE'; 55/65 entram como DADO na F4) — some do arquivo → deleted='S';
 *    volta → revive;
 *  - NBS também é presença (a lista da Calculadora é a lista vigente): some da lista →
 *    deleted='S' (o lookup e o cadastro deixam de aceitá-la; a FK do serviço continua);
 *    volta → revive;
 *  - linha de vigência não confirmada pela Calculadora (reconcile.ts) entra SEM aplicabilidade;
 *  - o relatório lista as CHAVES desativadas — é o que o Super confere no ensaio;
 *  - D-IB28 (a): linha com ATRIBUTO divergente na Calculadora (`blocked`) perde a
 *    aplicabilidade só naquele modelo;
 *  - D-IB28 (c): perda > 10 % das linhas VIVAS de qualquer lista (aplicabilidade de cClassTrib,
 *    de cIndOp, NBS) = carga RECUSADA, salvo `allowShrink` (argumento --aceita-encolher do ato);
 *    no ensaio a recusa vira aviso no relatório;
 *  - D-IB28 (b): o relatório do ENSAIO lista, por schema de cliente, os serviços que usam cClassTrib
 *    ou cIndOp que fica SEM nenhuma aplicabilidade na NFS-e, ou NBS que perde a presença, nesta
 *    carga (só LEITURA nos clientes — D-IB32). A leitura dos clientes acontece DEPOIS do rollback
 *    do ensaio (nenhuma trava do catálogo segura N schemas) e NÃO roda no ato (o plano já bateu
 *    com o ensaio). Limite conhecido: um PUT que leu o catálogo antes do commit pode gravar um
 *    código que acabou de perder a presença — a IB-2 barra no faturamento.
 */

type Conn = Connection | PoolConnection

export interface Counts {
  inserted: number; updated: number; unchanged: number; deactivated: number; revived: number
  /** Chaves que perdem presença nesta carga (código|vigência|modelo, ou a NBS). */
  deactivatedKeys: string[]
  /** Linhas VIVAS antes da carga (base do limite de encolhimento — D-IB28 (c)). */
  aliveBefore: number
}
const zero = (): Counts => ({ inserted: 0, updated: 0, unchanged: 0, deactivated: 0, revived: 0, deactivatedKeys: [], aliveBefore: 0 })

/** D-IB28 (c): fração máxima de linhas vivas que uma carga pode desativar sem --aceita-encolher. */
export const SHRINK_LIMIT = 0.10

export interface ShrinkRow { list: 'applicability' | 'placeApplicability' | 'nbs'; aliveBefore: number; deactivated: number }

/** D-IB28 (b): serviços de um cliente que usam código/NBS que perde a presença nesta carga. */
export interface ImpactRow {
  schema: string
  /** Institution inativa também entra (os serviços voltam se ela for reativada). */
  institutionActive: boolean
  kind: 'cClassTrib' | 'cIndOp' | 'NBS'
  code: string
  services: number
  /** Até 50 ids dos serviços afetados (o resto só na contagem). */
  serviceIds: number[]
}

const IMPACT_IDS_MAX = 50

export interface ApplyInput {
  it:               ItCatalog
  itVersion:        string
  placeIndicators?: PlaceIndicatorRecord[]
  indopVersion?:    string
  nbs?:             NbsRecord[]
  nbsVersion?:      string
  /** Linhas de vigência sem confirmação da Calculadora — sem aplicabilidade (reconcile.ts). */
  unconfirmed:      Array<{ code: string; validFrom: string }>
  /** Modelos cuja aplicabilidade esta carga gerencia. */
  models:           Array<'SE' | '55' | '65'>
  apply:            boolean
  /** D-IB28 (a): linhas que perdem a aplicabilidade só no modelo (atributo divergente). */
  blocked?:         Array<{ code: string; validFrom: string; model: 'SE' | '55' | '65' }>
  /** D-IB28 (c): --aceita-encolher. */
  allowShrink?:     boolean
  /** D-IB28 (b): calcular o impacto nos schemas dos clientes (a rotina do Super sempre pede). */
  reportImpact?:    boolean
  /** Data da carga: o impacto do cClassTrib olha a linha VIGENTE nela (sem data: qualquer linha viva). */
  date?:            string
}

export interface ApplyReport {
  applied:               boolean
  cst:                   Counts
  classification:        Counts
  validity:              Counts
  applicability:         Counts
  placeIndicator:        Counts
  placeApplicability:    Counts
  nbs:                   Counts
  /** Listas que encolheram mais que o limite (D-IB28 (c)) — no ensaio, aviso; no ato sem --aceita-encolher, recusa. */
  shrink:                ShrinkRow[]
  impact:                ImpactRow[]
  /** Schema em que o impacto não pôde ser lido (sem permissão, tabela ausente) — nunca silencioso. */
  impactProblems:        string[]
}

const C = 'setes_central'

async function syncApplicability(
  conn: Conn, table: string, keyCols: string[], desired: Array<Record<string, string>>,
  models: string[], counts: Counts,
): Promise<void> {
  const [existing] = await conn.query<any[]>(
    `SELECT ${keyCols.map(k => `\`${k}\``).join(', ')}, \`model\`, \`deleted\` FROM ${C}.\`${table}\`
      WHERE \`model\` IN (?) FOR UPDATE`, [models])
  const id = (r: Record<string, any>) => [...keyCols.map(k => String(r[k] instanceof Date ? r[k].toISOString().slice(0, 10) : r[k])), r.model].join('|')
  const have = new Map<string, any>(existing.map(r => [id(r), r]))
  counts.aliveBefore = existing.filter(r => r.deleted === 'N').length
  const want = new Set(desired.map(id))
  const where = `${keyCols.map(k => `\`${k}\` = ?`).join(' AND ')} AND \`model\` = ?`
  for (const d of desired) {
    const row = have.get(id(d))
    const params = [...keyCols.map(k => d[k]), d.model]
    if (!row) {
      await conn.query(
        `INSERT INTO ${C}.\`${table}\` (${keyCols.map(k => `\`${k}\``).join(', ')}, \`model\`, created_at, updated_at, deleted)
         VALUES (${keyCols.map(() => '?').join(', ')}, ?, NOW(), NOW(), 'N')`, params)
      counts.inserted++
    } else if (row.deleted !== 'N') {
      await conn.query(`UPDATE ${C}.\`${table}\` SET deleted = 'N', updated_at = NOW() WHERE ${where}`, params)
      counts.revived++
    } else counts.unchanged++
  }
  for (const [k, row] of have) {
    if (!want.has(k) && row.deleted === 'N') {
      await conn.query(`UPDATE ${C}.\`${table}\` SET deleted = 'S', updated_at = NOW() WHERE ${where}`,
        [...keyCols.map(c => row[c] instanceof Date ? row[c].toISOString().slice(0, 10) : row[c]), row.model])
      counts.deactivated++
      counts.deactivatedKeys.push(k)
    }
  }
}

const isoDate = (v: any): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)

export async function applyCatalog(conn: Conn, input: ApplyInput): Promise<ApplyReport> {
  const report: ApplyReport = {
    applied: false, cst: zero(), classification: zero(), validity: zero(), applicability: zero(),
    placeIndicator: zero(), placeApplicability: zero(), nbs: zero(),
    shrink: [], impact: [], impactProblems: [],
  }
  await conn.query(`SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'STRICT_ALL_TABLES')`)
  await conn.beginTransaction()
  try {
    // Serializa cargas concorrentes (a 2ª espera a 1ª terminar).
    await conn.query(`SELECT id FROM ${C}.tb_tax_ibscbs FOR UPDATE`)

    // --- CST ----------------------------------------------------------------
    const [cstRows] = await conn.query<any[]>(`SELECT id, description FROM ${C}.tb_tax_ibscbs`)
    const cstHave = new Map<string, any>(cstRows.map(r => [r.id, r]))
    for (const cst of input.it.csts) {
      const row = cstHave.get(cst.id)
      if (!row) {
        await conn.query(
          `INSERT INTO ${C}.tb_tax_ibscbs (id, description, source_version, created_at, updated_at, deleted)
           VALUES (?, ?, ?, NOW(), NOW(), 'N')`, [cst.id, cst.description, input.itVersion])
        report.cst.inserted++
      } else if (row.description !== cst.description) {
        await conn.query(`UPDATE ${C}.tb_tax_ibscbs SET description = ?, source_version = ?, updated_at = NOW() WHERE id = ?`,
          [cst.description, input.itVersion, cst.id])
        report.cst.updated++
      } else report.cst.unchanged++
    }

    // --- Identidade do cClassTrib (D-IB22) ----------------------------------
    const [idRows] = await conn.query<any[]>(`SELECT code, tb_tax_ibscbs_id AS cst FROM ${C}.tb_tax_ibscbs_classification`)
    const idHave = new Map<string, string>(idRows.map(r => [r.code, r.cst]))
    const codes = new Map<string, ClassificationRecord>()
    for (const c of input.it.classifications) codes.set(c.code, c)
    for (const [code, c] of codes) {
      const cst = idHave.get(code)
      if (cst === undefined) {
        await conn.query(
          `INSERT INTO ${C}.tb_tax_ibscbs_classification (code, tb_tax_ibscbs_id, created_at, updated_at, deleted)
           VALUES (?, ?, NOW(), NOW(), 'N')`, [code, c.cst])
        report.classification.inserted++
      } else if (cst !== c.cst) {
        throw new Error(`cClassTrib ${code}: CST mudou de ${cst} para ${c.cst} — identidade não muda (D-IB22); conferir a fonte`)
      } else report.classification.unchanged++
    }

    // --- História (vigência) -------------------------------------------------
    const [vRows] = await conn.query<any[]>(
      `SELECT code, valid_from, valid_until, name, description, requires_regular_taxation, source_updated_at
         FROM ${C}.tb_tax_ibscbs_classification_validity`)
    const vHave = new Map<string, any>(vRows.map(r => [`${r.code}|${isoDate(r.valid_from)}`, r]))
    for (const c of input.it.classifications) {
      const row = vHave.get(`${c.code}|${c.validFrom}`)
      const regular = c.requiresRegularTaxation ? 'S' : 'N'
      if (!row) {
        await conn.query(
          `INSERT INTO ${C}.tb_tax_ibscbs_classification_validity
             (code, valid_from, valid_until, name, description, requires_regular_taxation,
              source_version, source_updated_at, created_at, updated_at, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
          [c.code, c.validFrom, c.validUntil, c.name, c.description, regular, input.itVersion, c.updatedAt])
        report.validity.inserted++
      } else if (isoDate(row.valid_until) !== c.validUntil || row.name !== c.name || row.description !== c.description
                 || row.requires_regular_taxation !== regular || isoDate(row.source_updated_at) !== c.updatedAt) {
        await conn.query(
          `UPDATE ${C}.tb_tax_ibscbs_classification_validity
              SET valid_until = ?, name = ?, description = ?, requires_regular_taxation = ?,
                  source_version = ?, source_updated_at = ?, deleted = 'N', updated_at = NOW()
            WHERE code = ? AND valid_from = ?`,
          [c.validUntil, c.name, c.description, regular, input.itVersion, c.updatedAt, c.code, c.validFrom])
        report.validity.updated++
      } else report.validity.unchanged++
    }

    // --- Aplicabilidade por modelo (presença) --------------------------------
    const unconfirmed = new Set(input.unconfirmed.map(u => `${u.code}|${u.validFrom}`))
    const blocked = new Set((input.blocked ?? []).map(b => `${b.code}|${b.validFrom}|${b.model}`))
    const desired = input.it.classifications
      .filter(c => !unconfirmed.has(`${c.code}|${c.validFrom}`))
      .flatMap(c => c.models.filter(m => input.models.includes(m)).map(m => ({ code: c.code, valid_from: c.validFrom, model: m })))
      .filter(d => !blocked.has(`${d.code}|${d.valid_from}|${d.model}`))
    await syncApplicability(conn, 'tb_tax_ibscbs_classification_applicability', ['code', 'valid_from'], desired, input.models, report.applicability)

    // --- cIndOp (Anexo VII) ---------------------------------------------------
    if (input.placeIndicators) {
      const [pRows] = await conn.query<any[]>(`SELECT code, description FROM ${C}.tb_ibscbs_place_indicator`)
      const pHave = new Map<string, any>(pRows.map(r => [r.code, r]))
      for (const p of input.placeIndicators) {
        const row = pHave.get(p.code)
        if (!row) {
          await conn.query(
            `INSERT INTO ${C}.tb_ibscbs_place_indicator (code, description, source_version, created_at, updated_at, deleted)
             VALUES (?, ?, ?, NOW(), NOW(), 'N')`, [p.code, p.description, input.indopVersion ?? '?'])
          report.placeIndicator.inserted++
        } else if (row.description !== p.description) {
          await conn.query(`UPDATE ${C}.tb_ibscbs_place_indicator SET description = ?, source_version = ?, deleted = 'N', updated_at = NOW() WHERE code = ?`,
            [p.description, input.indopVersion ?? '?', p.code])
          report.placeIndicator.updated++
        } else report.placeIndicator.unchanged++
      }
      const pModels = input.models.filter(m => m === 'SE' || m === '55')
      const pDesired = input.placeIndicators.flatMap(p => p.models.filter(m => pModels.includes(m)).map(m => ({ code: p.code, model: m })))
      await syncApplicability(conn, 'tb_ibscbs_place_indicator_applicability', ['code'], pDesired, pModels, report.placeApplicability)
    }

    // --- NBS ------------------------------------------------------------------
    if (input.nbs) {
      const [nRows] = await conn.query<any[]>(`SELECT code, description, deleted FROM ${C}.tb_nbs`)
      const nHave = new Map<string, any>(nRows.map(r => [r.code, r]))
      report.nbs.aliveBefore = nRows.filter(r => r.deleted === 'N').length
      for (const n of input.nbs) {
        const row = nHave.get(n.code)
        if (!row) {
          await conn.query(
            `INSERT INTO ${C}.tb_nbs (code, description, source_version, created_at, updated_at, deleted)
             VALUES (?, ?, ?, NOW(), NOW(), 'N')`, [n.code, n.description, input.nbsVersion ?? '?'])
          report.nbs.inserted++
        } else if (row.description !== n.description || row.deleted !== 'N') {
          await conn.query(`UPDATE ${C}.tb_nbs SET description = ?, source_version = ?, deleted = 'N', updated_at = NOW() WHERE code = ?`,
            [n.description, input.nbsVersion ?? '?', n.code])
          if (row.deleted !== 'N') report.nbs.revived++
          else report.nbs.updated++
        } else report.nbs.unchanged++
      }
      const listed = new Set(input.nbs.map(n => n.code))
      for (const row of nRows) {
        if (!listed.has(row.code) && row.deleted === 'N') {
          await conn.query(`UPDATE ${C}.tb_nbs SET deleted = 'S', updated_at = NOW() WHERE code = ?`, [row.code])
          report.nbs.deactivated++
          report.nbs.deactivatedKeys.push(row.code)
        }
      }
    }

    // --- D-IB28 (c): encolhimento — decidido ANTES de qualquer leitura de cliente --------
    for (const list of ['applicability', 'placeApplicability', 'nbs'] as const) {
      const c = report[list]
      if (c.aliveBefore > 0 && c.deactivated / c.aliveBefore > SHRINK_LIMIT) {
        report.shrink.push({ list, aliveBefore: c.aliveBefore, deactivated: c.deactivated })
      }
    }
    if (input.apply && report.shrink.length && !input.allowShrink) {
      throw new CatalogSourceError(
        `A carga desativaria mais de ${SHRINK_LIMIT * 100} % das linhas vivas — recusada (nada gravado); se for intencional, rode o ensaio e o ato com --aceita-encolher`,
        report.shrink.map(r => `${r.list}: ${r.deactivated} de ${r.aliveBefore}`))
    }
    // --- D-IB28 (b): o que fica SEM aplicabilidade (consulta CENTRAL, no estado pós-carga) ------
    const lost = input.reportImpact && !input.apply ? await lostAfterLoad(conn, report, input.date) : null
    if (input.apply) {
      await conn.commit()
      report.applied = true
    } else {
      await conn.rollback()
    }
    // leitura dos clientes FORA da transação do catálogo (nenhuma trava central segura N schemas)
    if (lost) await reportImpact(conn, report, lost)
    return report
  } catch (err) {
    await conn.rollback()
    throw err
  }
}

const SCHEMA_RE = /^[a-z0-9_]+$/

interface LostCodes { classifications: string[]; placeIndicators: string[]; nbs: string[] }

/** Códigos que esta carga deixa SEM aplicabilidade na NFS-e e NBS que perdeu a presença. cClassTrib:
 *  conta como vivo só se uma linha VIGENTE na data da carga tem aplicabilidade SE (gate adversarial do
 *  delta: correção de dIniVig para o FUTURO deixava a linha de hoje sem aplicabilidade e o relatório
 *  dizia "ainda aceito" pela linha futura); cIndOp não tem vigência — qualquer aplicabilidade viva.
 *  Só tabelas CENTRAIS, na transação da carga (estado pós-carga, antes do rollback/commit). */
async function lostAfterLoad(conn: Conn, report: ApplyReport, date?: string): Promise<LostCodes> {
  const codesOf = (keys: string[]) => [...new Set(keys.filter(k => k.endsWith('|SE')).map(k => k.split('|')[0]))]
  const candidatesCls = codesOf(report.applicability.deactivatedKeys)
  const candidatesPlace = codesOf(report.placeApplicability.deactivatedKeys)
  const stillAlive = async (table: string, codes: string[]): Promise<Set<string>> => {
    if (!codes.length) return new Set()
    const [rows] = await conn.query<any[]>(
      `SELECT DISTINCT code FROM ${C}.\`${table}\` WHERE model = 'SE' AND deleted = 'N' AND code IN (?)`, [codes])
    return new Set(rows.map(r => String(r.code)))
  }
  const aliveCls = date === undefined || !candidatesCls.length
    ? await stillAlive('tb_tax_ibscbs_classification_applicability', candidatesCls)
    : new Set<string>((await conn.query<any[]>(
        `SELECT DISTINCT v.code FROM ${C}.tb_tax_ibscbs_classification_validity v
           JOIN ${C}.tb_tax_ibscbs_classification_applicability a
             ON a.code = v.code AND a.valid_from = v.valid_from AND a.model = 'SE' AND a.deleted = 'N'
          WHERE v.deleted = 'N' AND v.code IN (?) AND v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until >= ?)`,
        [candidatesCls, date, date]))[0].map((r: any) => String(r.code)))
  const alivePlace = await stillAlive('tb_ibscbs_place_indicator_applicability', candidatesPlace)
  return {
    classifications: candidatesCls.filter(c => !aliveCls.has(c)),
    placeIndicators: candidatesPlace.filter(c => !alivePlace.has(c)),
    nbs: report.nbs.deactivatedKeys,
  }
}

/** Serviços VIVOS de cada cliente que usam o que ficou sem aplicabilidade/presença (D-IB28 (b)).
 *  Erro de leitura num schema vira problema listado — nunca derruba o ensaio nem passa em silêncio. */
async function reportImpact(conn: Conn, report: ApplyReport, lost: LostCodes): Promise<void> {
  if (!lost.classifications.length && !lost.placeIndicators.length && !lost.nbs.length) return
  const [inst] = await conn.query<any[]>(
    `SELECT schema_name, active FROM ${C}.tb_institution WHERE deleted = 'N' ORDER BY schema_name`)
  for (const { schema_name: schema, active } of inst) {
    const institutionActive = active === 'S'
    if (!SCHEMA_RE.test(String(schema))) { report.impactProblems.push(`${schema}: nome de schema fora do padrão — ignorado`); continue }
    try {
      const alive = `JOIN \`${schema}\`.tb_product p ON p.id = s.id AND p.tb_institution_id = s.tb_institution_id AND p.deleted = 'N' AND p.kind = 'S'`
      const count = async (kind: ImpactRow['kind'], table: string, column: string, codes: string[]) => {
        if (!codes.length) return
        const [rows] = await conn.query<any[]>(
          `SELECT s.${column} AS code, COUNT(*) AS n, GROUP_CONCAT(s.id ORDER BY s.id SEPARATOR ',') AS ids
             FROM \`${schema}\`.${table} s ${alive}
            WHERE s.deleted = 'N' AND s.${column} IN (?) GROUP BY s.${column}`, [codes])
        for (const r of rows) {
          const serviceIds = String(r.ids ?? '').split(',').filter(Boolean).slice(0, IMPACT_IDS_MAX).map(Number)
          report.impact.push({ schema, institutionActive, kind, code: r.code, services: Number(r.n), serviceIds })
        }
      }
      await count('cClassTrib', 'tb_service_ibscbs', 'classification_code', lost.classifications)
      await count('cIndOp', 'tb_service_ibscbs', 'place_indicator_code', lost.placeIndicators)
      await count('NBS', 'tb_service', 'nbs', lost.nbs)
    } catch (err: any) {
      report.impactProblems.push(`${schema}: ${err?.code ?? err?.message ?? err}`)
    }
  }
}
