import type { Connection, PoolConnection } from 'mysql2/promise'
import {
  ClassificationRefusal, ClassificationVerdict, MODEL_NFSE, classificationRegistrationVerdicts, classificationVerdictsAt,
  registrationWindowEnd,
} from '@shared/ibscbs-classification'
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
 *  - D-IB36: linha que SOME da fonte ganha o fato `absent_since_version` (a versão do IT em que
 *    deixou de vir) — a peça de classificação a ignora; voltou na fonte = o fato é limpo
 *    (relatório: validity.deactivated/revived + chaves);
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
 *    de cIndOp, NBS e — D-IB39 — as marcações "ausente da fonte" da história; D-IB44 — somadas às
 *    linhas VIGENTES na data da carga cuja vigência a fonte encerrou antes dela) = carga RECUSADA,
 *    salvo `allowShrink` (argumento --aceita-encolher do ato);
 *    no ensaio a recusa vira aviso no relatório;
 *  - D-IB28 (b): o relatório do ENSAIO lista, por schema de cliente, os serviços que usam cClassTrib
 *    ou cIndOp que fica SEM nenhuma aplicabilidade na NFS-e (D-IB44: inclusive cClassTrib cuja linha
 *    vigente teve a vigência encerrada nesta carga), ou NBS que perde a presença, nesta
 *    carga. D-IB47: "aceito" é o VEREDITO da PEÇA de classificação na data do fato (`classificationVerdictsAt` —
 *    linha vigente com presença e sem tributação regular), na conexão da transação; o impacto do cClassTrib é a
 *    DIFERENÇA do veredito ANTES × DEPOIS da gravação para todo código que a carga pode tocar (gate socrático do
 *    delta R7: inferir pelo TIPO da mudança perdia a linha nova sobreposta que já vale na data, sem presença);
 *    a linha do impacto traz o motivo (`reason`) e marca quando o cadastro ainda aceita o código
 *    (`registrationStillAccepts` — linha futura ACEITA na janela: pickForRegistration; D-IB59: entre as vigentes só a mais nova conta).
 *    D-IB45: `impactAhead` (informativo, FORA do limite) lista os serviços cujo código aceito depois da carga deixa
 *    de ser aceito até o HORIZONTE (D-IB49: o maior entre o fim da janela do cadastro e a data + AHEAD_DAYS dias —
 *    `impactAheadUntil`), com a data e o motivo da perda; D-IB50: parte também do código aceito só pelo CADASTRO (linha
 *    futura na janela — o que o selo mostra), que perde depois de passar a valer (`acceptedFrom`); D-IB51: a linha traz o
 *    dia em que o código VOLTA a ser aceito dentro do horizonte (`acceptedAgainFrom` — buraco temporário); D-IB54: e a 1ª perda
 *    depois da volta (`lostAgainFrom`); D-IB56: sem volta aceita, a data da linha da FONTE que voltaria se a Calculadora a
 *    conferisse (`pendingReturnFrom` — A-IB1: espere a próxima carga em vez de reclassificar). D-IB53: o impacto
 *    compara também o veredito do CADASTRO antes × depois para o que a data do fato já recusava (o selo muda de "aceita" para
 *    "não aceita") — linha com `registrationOnly: true`;
 *    (só LEITURA nos clientes — D-IB32). A leitura dos clientes acontece DEPOIS do rollback
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

export interface ShrinkRow {
  list: 'applicability' | 'placeApplicability' | 'nbs' | 'validity'
  aliveBefore: number
  /** Linhas que a carga tira: desativadas (presença) — na história (D-IB39/D-IB44), as ausentes da fonte MAIS as
   *  com a vigência encerrada antes da data (≠ `relatorio.validity.deactivated`, que conta só as ausentes). */
  deactivated: number
  /** Só na história (validity): linha marcada cujo código SEGUE na fonte com outra linha (ex.: vigência corrigida) ×
   *  linha de código que SUMIU da fonte (suspeita de IT antigo/errado). */
  codeInSource?: number
  codeVanished?: number
  /** Só na história (D-IB44): linhas vigentes na data da carga cuja vigência a fonte encerrou antes dela. */
  endedBeforeDate?: number
  /** D-IB46: só na história, com data — linhas presentes e VIGENTES na data antes da carga (ao lado da base: a base
   *  conta também as encerradas e as futuras; reabrir a decisão quando vigentes/presentes < 80 %). */
  vigentOnDate?: number
  /** Desdobramento das encerradas (só quando há): o código tem OUTRA linha vigente na data (substituição — ex.: fim de
   *  ano com sucessora) × não tem (o código deixa de valer — suspeita de IT errado). Data = a da carga. */
  endedWithSuccessor?: number
  endedNoSuccessor?:   number
  beforeDate?:         string
}

/** Rótulo da lista na mensagem de recusa — quem lê é o operador, não o código. */
const SHRINK_LABEL: Record<ShrinkRow['list'], string> = {
  applicability:      'presença do cClassTrib por modelo',
  placeApplicability: 'presença do cIndOp por modelo',
  nbs:                'NBS da lista oficial',
  validity:           'história do cClassTrib (linhas ausentes da fonte ou com a vigência encerrada antes da data da carga)',
}

export function shrinkLine(r: ShrinkRow): string {
  const ended = r.endedBeforeDate
    ? `, ${r.endedBeforeDate} com a vigência encerrada antes de ${r.beforeDate} (${r.endedWithSuccessor} de código com outra ` +
      `linha vigente nessa data, ${r.endedNoSuccessor} de código sem linha vigente nessa data)`
    : ', 0 com a vigência encerrada antes da data da carga'
  const split = r.list === 'validity' && r.codeInSource != null
    ? ` — ${r.codeInSource} de código que segue na fonte (ex.: vigência corrigida), ${r.codeVanished} de código que sumiu da fonte${ended}`
    : ''
  const vigent = r.vigentOnDate != null ? `; vigentes na data antes da carga: ${r.vigentOnDate}` : ''
  return `${SHRINK_LABEL[r.list]} [${r.list}]: ${r.deactivated} de ${r.aliveBefore}${split}${vigent}`
}

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
  /** D-IB47: só cClassTrib — o cadastro ainda aceita o código (linha futura ACEITA na janela — D-IB57; D-IB59: uma vigente mais antiga nunca conta; antes: outra linha vigente com
   *  presença — pickForRegistration; o selo da aba diz "aceita"), mas a data do fato (faturamento) já não. */
  registrationStillAccepts?: boolean
  /** D-IB47: só cClassTrib — por que deixa de ser aceito: no impacto, na data da carga (com `registrationOnly`, pela regra do
   *  CADASTRO — D-IB53); no aviso, na data da perda. */
  reason?: ClassificationRefusal
  /** D-IB45: só em `impactAhead` — o 1º dia em que o código, aceito na data da carga (pela data do fato ou só pelo cadastro —
   *  D-IB50), deixa de ser aceito na NFS-e dentro do horizonte (D-IB49). */
  lossDate?: string
  /** D-IB50: só em `impactAhead`, código aceito só pelo cadastro na data da carga — o dia em que passa a valer na data do fato. */
  acceptedFrom?: string
  /** D-IB51: só em `impactAhead` — o dia em que o código VOLTA a ser aceito dentro do horizonte (buraco temporário); ausente = não volta dentro do horizonte. */
  acceptedAgainFrom?: string
  /** D-IB54: só em `impactAhead` — a 1ª perda DEPOIS da volta, dentro do horizonte (a volta não garante o aceite até o fim). */
  lostAgainFrom?: string
  /** D-IB56: só em `impactAhead` e só SEM volta aceita — a linha da fonte que faria o código voltar se a Calculadora a conferisse
   *  (A-IB1), começando na perda ou depois dela, dentro do horizonte; não diz até quando a linha vale nem pega a que começa ANTES
   *  da perda (conferir no IT); ausente = nenhuma pendente. Só a 1ª volta e a 1ª perda depois dela aparecem (D-IB54) — uma 3ª
   *  perda não. */
  pendingReturnFrom?: string
  /** D-IB53: só em `impact` — a data do fato já recusava antes da carga; quem deixou de aceitar foi o CADASTRO (o selo muda). */
  registrationOnly?: true
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
  /** D-IB28 (b): calcular o impacto nos schemas dos clientes (a rotina do Super sempre pede) — só no ensaio e EXIGE `date`. */
  reportImpact?:    boolean
  /** Data da carga: limite da história (D-IB44), impacto e aviso (veredito da peça nela). */
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
  /** D-IB44: linhas da história VIGENTES na data da carga (presentes na fonte) cuja vigência a fonte
   *  encerrou antes dela — chave código|vigência; sem data, sempre vazio. */
  validityEnded:         string[]
  /** D-IB47: linhas vigentes na data em que a fonte LIGOU a exigência de tributação regular (candidatas ao impacto). */
  validityRegularOn:     string[]
  /** D-IB46: linhas presentes e vigentes na data antes da carga (sem data, 0). */
  validityVigentOnDate:  number
  /** Listas que encolheram mais que o limite (D-IB28 (c)) — no ensaio, aviso; no ato sem --aceita-encolher, recusa. */
  shrink:                ShrinkRow[]
  impact:                ImpactRow[]
  /** D-IB45/D-IB49/D-IB50: aviso PROSPECTIVO (fora do limite) — serviços cujo código, aceito na data da carga pela data do
   *  fato ou só pelo cadastro, deixa de ser aceito até o horizonte (`impactAheadUntil`), com a data e o motivo da perda; só
   *  no ensaio. A 1ª perda, a 1ª volta (D-IB51), a 1ª perda depois da volta (D-IB54) e a volta pendente de conferência
   *  (D-IB56). Não traz recusa HERDADA de carga anterior (D-IB52 — pré-voo do faturamento na IB-2). */
  impactAhead:           ImpactRow[]
  /** D-IB49: até quando o aviso olhou (o maior entre o fim da janela do cadastro e a data + AHEAD_DAYS); null fora do ensaio. */
  impactAheadUntil:      string | null
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
    validityEnded: [], validityRegularOn: [], validityVigentOnDate: 0, shrink: [], impact: [], impactAhead: [], impactAheadUntil: null, impactProblems: [],
  }
  await conn.query(`SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'STRICT_ALL_TABLES')`)
  await conn.beginTransaction()
  try {
    // Serializa cargas concorrentes (a 2ª espera a 1ª terminar).
    await conn.query(`SELECT id FROM ${C}.tb_tax_ibscbs FOR UPDATE`)

    // D-IB47 (gate socrático do delta R7): o veredito ANTES de qualquer gravação, para todo código que a carga pode
    // tocar (o catálogo inteiro ∪ a fonte) — o impacto é a diferença antes × depois, nunca inferido pelo tipo da mudança
    let before: Map<string, ClassificationVerdict> | null = null
    let beforeRegistration = new Map<string, ClassificationVerdict>()
    if (input.reportImpact && !input.apply) {
      if (!input.date) throw new Error('reportImpact exige a data da carga (date) — o veredito é na data do fato')
      const [idCodes] = await conn.query<any[]>(`SELECT code FROM ${C}.tb_tax_ibscbs_classification`)
      const touched = [...new Set([...idCodes.map(r => String(r.code)), ...input.it.classifications.map(c => c.code)])].sort()
      before = await classificationVerdictsAt(conn, touched, MODEL_NFSE, input.date)
      // D-IB53: para o que a data do fato já recusa, o veredito do CADASTRO antes (o que o selo mostra)
      const refused = touched.filter(c => !before!.get(c)!.accepted)
      beforeRegistration = await classificationRegistrationVerdicts(conn, refused, MODEL_NFSE, input.date)
    }

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
      `SELECT code, valid_from, valid_until, name, description, requires_regular_taxation, source_updated_at,
              absent_since_version
         FROM ${C}.tb_tax_ibscbs_classification_validity`)
    const vHave = new Map<string, any>(vRows.map(r => [`${r.code}|${isoDate(r.valid_from)}`, r]))
    // D-IB39: base do limite de encolhimento da história = linhas PRESENTES na fonte antes da carga
    report.validity.aliveBefore = vRows.filter(r => r.absent_since_version == null).length
    const vigentOn = (r: any, d: string) => r.absent_since_version == null && isoDate(r.valid_from)! <= d
      && (r.valid_until == null || isoDate(r.valid_until)! >= d)
    if (input.date) report.validityVigentOnDate = vRows.filter(r => vigentOn(r, input.date!)).length
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
                 || row.requires_regular_taxation !== regular || isoDate(row.source_updated_at) !== c.updatedAt
                 || row.absent_since_version != null) {
        await conn.query(
          `UPDATE ${C}.tb_tax_ibscbs_classification_validity
              SET valid_until = ?, name = ?, description = ?, requires_regular_taxation = ?,
                  source_version = ?, source_updated_at = ?, absent_since_version = NULL, deleted = 'N', updated_at = NOW()
            WHERE code = ? AND valid_from = ?`,
          [c.validUntil, c.name, c.description, regular, input.itVersion, c.updatedAt, c.code, c.validFrom])
        if (row.absent_since_version != null) report.validity.revived++
        else report.validity.updated++
        if (input.date && vigentOn(row, input.date)) {
          // D-IB44: vigente na data da carga antes; a fonte encerrou a vigência antes dela
          if (c.validUntil != null && c.validUntil < input.date) report.validityEnded.push(`${c.code}|${c.validFrom}`)
          // D-IB47: a fonte LIGOU a exigência de tributação regular numa linha vigente — o documento deixa de aceitar
          else if (row.requires_regular_taxation !== 'S' && regular === 'S') report.validityRegularOn.push(`${c.code}|${c.validFrom}`)
        }
      } else report.validity.unchanged++
    }
    // D-IB36: o que estava presente e NÃO veio nesta versão da fonte ganha o fato (nunca é apagado)
    const inSource = new Set(input.it.classifications.map(c => `${c.code}|${c.validFrom}`))
    for (const row of vRows) {
      const key = `${row.code}|${isoDate(row.valid_from)}`
      if (!inSource.has(key) && row.absent_since_version == null) {
        await conn.query(
          `UPDATE ${C}.tb_tax_ibscbs_classification_validity
              SET absent_since_version = ?, updated_at = NOW()
            WHERE code = ? AND valid_from = ?`,
          [input.itVersion, row.code, isoDate(row.valid_from)])
        report.validity.deactivated++
        report.validity.deactivatedKeys.push(key)
      }
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
    // D-IB39: as marcações 'ausente da fonte' (validity) também contam — IT antigo carregado por engano
    const codesInSource = new Set(input.it.classifications.map(c => c.code))
    // D-IB44: na história, somam as linhas vigentes na data cuja vigência a fonte encerrou antes dela
    for (const list of ['applicability', 'placeApplicability', 'nbs', 'validity'] as const) {
      const c = report[list]
      const ended = list === 'validity' ? report.validityEnded.length : 0
      const lost = c.deactivated + ended
      if (c.aliveBefore > 0 && lost / c.aliveBefore > SHRINK_LIMIT) {
        const row: ShrinkRow = { list, aliveBefore: c.aliveBefore, deactivated: lost }
        if (list === 'validity' && input.date) row.vigentOnDate = report.validityVigentOnDate
        if (list === 'validity') {
          const codeInSource = c.deactivatedKeys.filter(k => codesInSource.has(k.split('|')[0])).length
          Object.assign(row, { codeInSource, codeVanished: c.deactivated - codeInSource, endedBeforeDate: ended })
          if (ended) Object.assign(row, await endedSplit(conn, report.validityEnded, input.date!))
        }
        report.shrink.push(row)
      }
    }
    if (input.apply && report.shrink.length && !input.allowShrink) {
      throw new CatalogSourceError(
        `A carga tiraria mais de ${SHRINK_LIMIT * 100} % das linhas vivas de alguma lista (desativadas; na história, ausentes da fonte ou com a vigência encerrada) — recusada (nada gravado); se for intencional, rode o ensaio e o ato com --aceita-encolher`,
        report.shrink.map(shrinkLine))
    }
    // --- D-IB28 (b): o que fica SEM aplicabilidade (consulta CENTRAL, no estado pós-carga) ------
    // D-IB56: linhas da fonte que voltariam a aceitar o código se a Calculadora as conferisse (presença no SE, sem tributação regular)
    const pendingReturns = input.it.classifications
      .filter(c => unconfirmed.has(`${c.code}|${c.validFrom}`) && c.models.includes('SE') && !c.requiresRegularTaxation)
      .map(c => ({ code: c.code, validFrom: c.validFrom }))
    const lost = before ? await lostAfterLoad(conn, report, input.date!, before, beforeRegistration, pendingReturns) : null
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

/** D-IB44 (gate socrático do delta R6): das linhas encerradas antes da data, quantas são de código que ainda tem OUTRA
 *  linha vigente na data (estado pós-carga, mesma transação) — o número que separa substituição de IT errado. */
async function endedSplit(conn: Conn, endedKeys: string[], date: string): Promise<Pick<ShrinkRow, 'endedWithSuccessor' | 'endedNoSuccessor' | 'beforeDate'>> {
  const codes = [...new Set(endedKeys.map(k => k.split('|')[0]))]
  const [rows] = await conn.query<any[]>(
    `SELECT DISTINCT code FROM ${C}.tb_tax_ibscbs_classification_validity
      WHERE code IN (?) AND deleted = 'N' AND absent_since_version IS NULL
        AND valid_from <= ? AND (valid_until IS NULL OR valid_until >= ?)`, [codes, date, date])
  const alive = new Set(rows.map(r => String(r.code)))
  const withSuccessor = endedKeys.filter(k => alive.has(k.split('|')[0])).length
  return { endedWithSuccessor: withSuccessor, endedNoSuccessor: endedKeys.length - withSuccessor, beforeDate: date }
}

const SCHEMA_RE = /^[a-z0-9_]+$/

interface LostCodes {
  /** cClassTrib aceito ANTES e não aceito DEPOIS da carga — na data do fato (D-IB47) ou, para o que o fato já recusava, pela
   *  regra do CADASTRO (D-IB53) — com o motivo. */
  classifications: Map<string, ClassificationRefusal>
  /** D-IB47: o cadastro ainda aceita o código perdido? */
  registration:    Map<string, boolean>
  placeIndicators: string[]
  nbs:             string[]
  /** D-IB53: códigos do impacto que só o CADASTRO deixou de aceitar (a data do fato já recusava antes). */
  registrationOnly: Set<string>
  /** D-IB45: código aceito × 1º dia em que deixa de ser aceito (dentro do horizonte) + motivo (+ D-IB50 desde quando vale;
   *  + D-IB51 quando volta). */
  ahead:           Array<{
    code: string; lossDate: string; reason: ClassificationRefusal
    acceptedFrom?: string; acceptedAgainFrom?: string; lostAgainFrom?: string; pendingReturnFrom?: string
  }>
}

const addDays = (d: string, n: number): string => {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10)
}
const nextDay = (d: string): string => addDays(d, 1)

/** D-IB49: dias à frente que o aviso prospectivo olha além da janela do cadastro (depois da obrigação, só eles). */
export const AHEAD_DAYS = 90

/** D-IB49: horizonte do aviso = o MAIOR entre o fim da janela do cadastro (a obrigação) e a data + AHEAD_DAYS. A janela
 *  só ganha para cargas até 2026-10-02 (reprodução com --date); desde 2026-10-03 o horizonte real é a data + AHEAD_DAYS. */
export function aheadHorizon(date: string): string {
  const window = registrationWindowEnd(date)
  // gate adversarial do delta R8 (LOW): data perto do fim do calendário não vira '+010000-…' — fica no último dia válido
  const plus = date > LAST_CALENDAR_DAY_MINUS_AHEAD ? LAST_CALENDAR_DAY : addDays(date, AHEAD_DAYS)
  return window !== null && window > plus ? window : plus
}
const LAST_CALENDAR_DAY = '9999-12-31'
const LAST_CALENDAR_DAY_MINUS_AHEAD = addDays(LAST_CALENDAR_DAY, -AHEAD_DAYS)

/** D-IB45/D-IB49/D-IB50: códigos ACEITOS na data da carga — pela data do fato OU só pelo cadastro (linha futura na janela)
 *  — que deixam de ser aceitos até o horizonte; datas candidatas = dia seguinte a cada fim de vigência e o início de cada
 *  linha nova dentro do horizonte; a pergunta é o veredito da peça, em LOTE por data. O aceito só pelo cadastro conta a
 *  perda DEPOIS de passar a valer (`acceptedFrom`). Estado pós-carga, na transação da carga. */
async function lossesAhead(
  conn: Conn, date: string, afterToday: Map<string, ClassificationVerdict>,
  pendingReturns: ReadonlyArray<{ code: string; validFrom: string }>,
): Promise<{ ahead: LostCodes['ahead']; aheadUntil: string }> {
  const end = aheadHorizon(date)
  const [rows] = await conn.query<any[]>(
    `SELECT /* ibscbs-ahead */ code, valid_from, valid_until FROM ${C}.tb_tax_ibscbs_classification_validity
      WHERE deleted = 'N' AND absent_since_version IS NULL
        AND ((valid_until >= ? AND valid_until < ?) OR (valid_from > ? AND valid_from <= ?))`, [date, end, date, end])
  // de onde o aviso parte: aceito na data do fato, ou (D-IB50) só pelo cadastro — nunca o que ninguém aceita
  const rowCodes = [...new Set(rows.map(r => String(r.code)))]
  const notToday = rowCodes.filter(c => !afterToday.get(c)?.accepted)
  const reg = notToday.length ? await classificationRegistrationVerdicts(conn, notToday, MODEL_NFSE, date) : new Map<string, ClassificationVerdict>()
  const start = new Map<string, 'fact' | 'registration'>()
  for (const c of rowCodes) {
    if (afterToday.get(c)?.accepted) start.set(c, 'fact')
    else if (reg.get(c)?.accepted) start.set(c, 'registration')
  }
  const dates = new Map<string, Set<string>>()
  for (const r of rows) {
    const code = String(r.code)
    if (!start.has(code)) continue   // ninguém aceita (ou perdido nesta carga sem linha do cadastro): é impacto, não aviso
    const set = dates.get(code) ?? new Set<string>()
    const until = isoDate(r.valid_until)
    const from = isoDate(r.valid_from)!
    if (until !== null && until >= date && until < end) set.add(nextDay(until))
    if (from > date && from <= end) set.add(from)
    dates.set(code, set)
  }
  // um veredito em lote por data candidata
  const byDate = new Map<string, string[]>()
  for (const [code, set] of dates) for (const d of set) byDate.set(d, [...(byDate.get(d) ?? []), code])
  const verdicts = new Map<string, Map<string, ClassificationVerdict>>()
  for (const d of [...byDate.keys()].sort()) verdicts.set(d, await classificationVerdictsAt(conn, byDate.get(d)!, MODEL_NFSE, d))
  const out: LostCodes['ahead'] = []
  for (const [code, set] of [...dates].sort(([a], [b]) => a.localeCompare(b))) {
    let accepted = start.get(code) === 'fact'
    let acceptedFrom: string | undefined
    const sorted = [...set].sort()
    for (let i = 0; i < sorted.length; i++) {
      const d = sorted[i]
      const v = verdicts.get(d)!.get(code)!
      if (v.accepted) { if (!accepted) { accepted = true; acceptedFrom = d } continue }
      if (accepted) {
        // D-IB51: volta a ser aceito dentro do horizonte? D-IB54: e perde de novo depois? (vereditos já calculados)
        const rest = sorted.slice(i + 1)
        const again = rest.find(x => verdicts.get(x)!.get(code)!.accepted)
        const lostAgain = again === undefined ? undefined
          : rest.slice(rest.indexOf(again) + 1).find(x => !verdicts.get(x)!.get(code)!.accepted)
        // D-IB56: SEM volta aceita, a linha da fonte não conferida pela Calculadora que voltaria (da perda ao horizonte)
        const pending = again !== undefined ? undefined
          : pendingReturns.filter(p => p.code === code && p.validFrom >= d && p.validFrom <= end).map(p => p.validFrom).sort()[0]
        out.push({
          code, lossDate: d, reason: v.reason!,
          ...(acceptedFrom ? { acceptedFrom } : {}), ...(again ? { acceptedAgainFrom: again } : {}),
          ...(lostAgain ? { lostAgainFrom: lostAgain } : {}), ...(pending ? { pendingReturnFrom: pending } : {}),
        })
        break
      }
    }
  }
  return { ahead: out, aheadUntil: end }
}

/** O que esta carga deixa de aceitar. cClassTrib: veredito da peça na data do fato ANTES × DEPOIS (D-IB47 — inclui a
 *  correção de dIniVig para o futuro, a vigência encerrada, a tributação regular ligada e a linha nova sobreposta sem
 *  presença); D-IB53: para o que o fato já recusava, o veredito do CADASTRO antes × depois — pela D-IB59 só uma linha FUTURA da
 *  janela pode dar essa aceitação (se o fato já recusava, a vigente mais nova já recusava) — `registrationOnly`;
 *  cIndOp não tem vigência — qualquer aplicabilidade viva;
 *  NBS — presença perdida. Só tabelas CENTRAIS, na transação da carga (estado pós-carga, antes do rollback). */
async function lostAfterLoad(
  conn: Conn, report: ApplyReport, date: string, before: Map<string, ClassificationVerdict>,
  beforeRegistration: Map<string, ClassificationVerdict>,
  pendingReturns: ReadonlyArray<{ code: string; validFrom: string }>,
): Promise<LostCodes> {
  const codesOf = (keys: string[]) => [...new Set(keys.filter(k => k.endsWith('|SE')).map(k => k.split('|')[0]))]
  const candidatesPlace = codesOf(report.placeApplicability.deactivatedKeys)
  const stillAlive = async (table: string, codes: string[]): Promise<Set<string>> => {
    if (!codes.length) return new Set()
    const [rows] = await conn.query<any[]>(
      `SELECT DISTINCT code FROM ${C}.\`${table}\` WHERE model = 'SE' AND deleted = 'N' AND code IN (?)`, [codes])
    return new Set(rows.map(r => String(r.code)))
  }
  const alivePlace = await stillAlive('tb_ibscbs_place_indicator_applicability', candidatesPlace)
  const placeIndicators = candidatesPlace.filter(c => !alivePlace.has(c))
  // D-IB47: a diferença do veredito — aceito antes, não aceito depois (mesma data, mesma peça, mesma transação)
  const after = await classificationVerdictsAt(conn, [...before.keys()], MODEL_NFSE, date)
  const classifications = new Map<string, ClassificationRefusal>()
  for (const [code, v] of before) {
    const now = after.get(code)!
    if (v.accepted && !now.accepted) classifications.set(code, now.reason!)
  }
  const reg = await classificationRegistrationVerdicts(conn, [...classifications.keys()], MODEL_NFSE, date)
  const registration = new Map([...classifications.keys()].map(c => [c, reg.get(c)?.accepted ?? false]))
  // D-IB53: a data do fato já recusava; o CADASTRO aceitava antes e deixa de aceitar depois (o selo muda) — também é impacto
  const wasRegistered = [...beforeRegistration].filter(([, v]) => v.accepted).map(([c]) => c)
  const registrationAfter = await classificationRegistrationVerdicts(conn, wasRegistered, MODEL_NFSE, date)
  const registrationOnly = new Set<string>()
  for (const code of wasRegistered) {
    const now = registrationAfter.get(code)!
    if (!now.accepted) {
      classifications.set(code, now.reason!)
      registration.set(code, false)
      registrationOnly.add(code)
    }
  }
  const { ahead, aheadUntil } = await lossesAhead(conn, date, after, pendingReturns)
  report.impactAheadUntil = aheadUntil
  return { classifications, registration, registrationOnly, placeIndicators, nbs: report.nbs.deactivatedKeys, ahead }
}

/** Serviços VIVOS de cada cliente que usam o que ficou sem aplicabilidade/presença (D-IB28 (b)).
 *  Erro de leitura num schema vira problema listado — nunca derruba o ensaio nem passa em silêncio. */
async function reportImpact(conn: Conn, report: ApplyReport, lost: LostCodes): Promise<void> {
  if (!lost.classifications.size && !lost.placeIndicators.length && !lost.nbs.length && !lost.ahead.length) return
  const ahead = new Map(lost.ahead.map(a => [a.code, a]))
  const [inst] = await conn.query<any[]>(
    `SELECT schema_name, active FROM ${C}.tb_institution WHERE deleted = 'N' ORDER BY schema_name`)
  for (const { schema_name: schema, active } of inst) {
    const institutionActive = active === 'S'
    if (!SCHEMA_RE.test(String(schema))) { report.impactProblems.push(`${schema}: nome de schema fora do padrão — ignorado`); continue }
    try {
      const alive = `JOIN \`${schema}\`.tb_product p ON p.id = s.id AND p.tb_institution_id = s.tb_institution_id AND p.deleted = 'N' AND p.kind = 'S'`
      const count = async (kind: ImpactRow['kind'], table: string, column: string, codes: string[],
                           target: ImpactRow[] = report.impact, extra: (code: string) => Partial<ImpactRow> = () => ({})) => {
        if (!codes.length) return
        const [rows] = await conn.query<any[]>(
          `SELECT s.${column} AS code, COUNT(*) AS n, GROUP_CONCAT(s.id ORDER BY s.id SEPARATOR ',') AS ids
             FROM \`${schema}\`.${table} s ${alive}
            WHERE s.deleted = 'N' AND s.${column} IN (?) GROUP BY s.${column}`, [codes])
        for (const r of rows) {
          const serviceIds = String(r.ids ?? '').split(',').filter(Boolean).slice(0, IMPACT_IDS_MAX).map(Number)
          target.push({ schema, institutionActive, kind, code: r.code, services: Number(r.n), serviceIds, ...extra(String(r.code)) })
        }
      }
      await count('cClassTrib', 'tb_service_ibscbs', 'classification_code', [...lost.classifications.keys()], report.impact,
        code => ({ registrationStillAccepts: lost.registration.get(code), reason: lost.classifications.get(code),
          ...(lost.registrationOnly.has(code) ? { registrationOnly: true as const } : {}) }))
      await count('cIndOp', 'tb_service_ibscbs', 'place_indicator_code', lost.placeIndicators)
      await count('NBS', 'tb_service', 'nbs', lost.nbs)
      await count('cClassTrib', 'tb_service_ibscbs', 'classification_code', [...ahead.keys()], report.impactAhead,
        code => {
          const a = ahead.get(code)!
          return { lossDate: a.lossDate, reason: a.reason, ...(a.acceptedFrom ? { acceptedFrom: a.acceptedFrom } : {}),
            ...(a.acceptedAgainFrom ? { acceptedAgainFrom: a.acceptedAgainFrom } : {}),
            ...(a.lostAgainFrom ? { lostAgainFrom: a.lostAgainFrom } : {}),
            ...(a.pendingReturnFrom ? { pendingReturnFrom: a.pendingReturnFrom } : {}) }
        })
    } catch (err: any) {
      report.impactProblems.push(`${schema}: ${err?.code ?? err?.message ?? err}`)
    }
  }
}
