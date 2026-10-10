import type { Connection, PoolConnection } from 'mysql2/promise'
import { ClassificationRecord, ItCatalog, NbsRecord, PlaceIndicatorRecord } from './parse'

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
 *  - o relatório lista as CHAVES desativadas — é o que o Super confere no ensaio.
 */

type Conn = Connection | PoolConnection

export interface Counts {
  inserted: number; updated: number; unchanged: number; deactivated: number; revived: number
  /** Chaves que perdem presença nesta carga (código|vigência|modelo, ou a NBS). */
  deactivatedKeys: string[]
}
const zero = (): Counts => ({ inserted: 0, updated: 0, unchanged: 0, deactivated: 0, revived: 0, deactivatedKeys: [] })

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
    const desired = input.it.classifications
      .filter(c => !unconfirmed.has(`${c.code}|${c.validFrom}`))
      .flatMap(c => c.models.filter(m => input.models.includes(m)).map(m => ({ code: c.code, valid_from: c.validFrom, model: m })))
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

    if (input.apply) {
      await conn.commit()
      report.applied = true
    } else {
      await conn.rollback()
    }
    return report
  } catch (err) {
    await conn.rollback()
    throw err
  }
}
