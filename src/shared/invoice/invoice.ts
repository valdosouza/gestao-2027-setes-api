import { PoolConnection } from 'mysql2/promise'
import { IbscbsDeclaration } from '@shared/ibscbs-classification'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'

/**
 * Peça da NOTA FISCAL (prompt_cancelamento_nota.md — D3/D4/D5/D17 + parecer
 * setes-conceito, 2026-09-08). A nota é um DOCUMENTO com história: cada
 * fato é um evento append-only em tb_invoice_event e o estado é DERIVADO
 * do último evento (irmã de @shared/check e @shared/bank-slip).
 *
 *   E emitida   — nasce AQUI, no faturamento (issueInvoice), nunca no módulo
 *   C cancelada — gravado pela composição invoice-cancel.ts
 *   reservados T A R D I (transmissão SEFAZ) — nunca 'X' (X é estorno na casa)
 *
 * Identidade da nota = o pedido (PK de tb_invoice = id do pedido, decisão
 * das notas mercadoria × serviço). Com D3 (pendente cancelada = soft-delete)
 * e D5 (pedido refaturável), o cabeçalho é REVIVIDO por upsert na segunda
 * vida — por isso o evento E guarda o SNAPSHOT do fato (número/série/
 * modelo/valor). `tb_invoice.status` é ESPELHO escrito aqui ('0' = pronta):
 * o estado FISCAL não mora nele — é do RAMO, derivado da última voz do fisco
 * da tentativa vigente, que desde a F2a é escrita SÓ pela nfse-api no banco
 * fiscal_api e LIDA aqui pela porta `@shared/fiscal-voice` (D-F11/D-F15). Ninguém
 * escreve `status` por causa do fisco; ele só é lido como cinto (Q-A2) contra
 * valor gravado pelo sync ('A'/'F' vindos do desktop não são "pendente").
 */

export type InvoiceEventKind = 'E' | 'C'
export type InvoiceState = 'issued' | 'cancelled'

/** Estado derivado do último evento. Sem evento (nota sincronizada) = emitida. */
export function stateFromLastEvent(kind: string | null | undefined): InvoiceState {
  return kind === 'C' ? 'cancelled' : 'issued'
}

/**
 * SQL do último evento de uma nota (subquery reutilizável nas listas) — `[alias]` é uma linha de `tb_invoice`.
 * D-F32 (F2a, etapa A2): lido da VIEW de política `vw_invoice_life` (migration 065 — a mesma que as APIs fiscais
 * leem), nunca de um "ORDER BY event DESC LIMIT 1" próprio: a definição de "último evento" mora num lugar só.
 * Sem evento (nota sincronizada da origem) → NULL, como antes.
 */
export const LAST_INVOICE_EVENT_KIND_SQL = (s: string, alias = 'i') =>
  `(SELECT lv.last_kind FROM \`${s}\`.vw_invoice_life lv
     WHERE lv.tb_institution_id = ${alias}.tb_institution_id
       AND lv.tb_invoice_id = ${alias}.id AND lv.terminal = ${alias}.terminal)`

export interface InvoiceSnapshot {
  number: string | null
  serie: string | null
  model: string | null
  value: number | null
}

export interface InvoiceEventInput {
  kind: InvoiceEventKind
  dtRecord: string
  note?: string | null
  originEvent?: number | null
  snapshot?: InvoiceSnapshot | null
}

/** Próximo evento (MAX+1 por nota, FOR UPDATE) + INSERT. Devolve o nº do evento. */
export async function insertInvoiceEvent(
  conn: PoolConnection, s: string, institutionId: number, invoiceId: number,
  userId: number | null, e: InvoiceEventInput
): Promise<number> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(event), 0) + 1 AS nextEvent
       FROM \`${s}\`.tb_invoice_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 FOR UPDATE`,
    [institutionId, invoiceId]
  )
  const event = Number(mx[0].nextEvent)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_invoice_event
       (tb_institution_id, tb_invoice_id, terminal, event, kind, dt_record,
        number, serie, model, value, origin_event, note, tb_user_id,
        created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, invoiceId, event, e.kind, e.dtRecord,
     e.snapshot?.number ?? null, e.snapshot?.serie ?? null,
     e.snapshot?.model ?? null, e.snapshot?.value ?? null,
     e.originEvent ?? null, e.note ? e.note.slice(0, 255) : null, userId]
  )
  return event
}

export interface LockedInvoice {
  id: number
  number: string | null
  serie: string | null
  model: string | null
  value: number
  status: string
  /** Evento E que abriu a VIDA vigente (D-N27); null = nota sem evento (sincronizada da origem). */
  lifeEvent: number | null
  lastEvent: number | null
  lastKind: string | null
}

/**
 * Nota viva (deleted='N') FOR UPDATE + vida e último evento. 404 INVOICE_NOT_FOUND.
 *
 * D-F32 (F2a, etapa A2 — prompt_apis_fiscais_isoladas.md §22.9): a vida e o último evento vêm da VIEW de política
 * `vw_invoice_life` (a MESMA do núcleo `fiscal-api` — `erp.lockInvoice`), no molde dele: o `FOR UPDATE` na linha da
 * nota é o 1º comando (o ponto de serialização dos dois serviços — D-F27/D-F121) e a view é lida em leitura travante
 * COMPARTILHADA (fresca: não depende do retrato do REPEATABLE READ — PADROES §9 regra 2). Antes era um "ORDER BY event
 * DESC LIMIT 1 FOR UPDATE" próprio em `tb_invoice_event`: a definição de "último evento" em duas cópias. Quem grava
 * evento (`insertInvoiceEvent`, MAX+1 FOR UPDATE) já está serializado pela trava da nota — e TEM de estar: a trava S que
 * esta leitura põe nos eventos faz um escritor que pule a trava da nota cair em deadlock S→X (gate adversarial da A2,
 * F2A2-ADV-03 — regra, não acaso).
 *
 * ⚠️ Conhecimento NEGATIVO (gates da A2, F2A2-ADV-02 — provado no MariaDB 10.4.20): a leitura travante da view só é
 * "fresca" nas tabelas do JOIN; os `NOT EXISTS` de dentro dela (o "último evento") leem o RETRATO do REPEATABLE READ. Se
 * a transação abriu o retrato ANTES desta trava (uma leitura não travante, ou um FOR UPDATE com subconsulta) e a nota foi
 * re-faturada no intervalo (E1, C2 → E3), a view devolve VÁRIAS linhas (vida × último, novos e velhos). Por isso: mais
 * de uma linha = o chamador violou "a trava da nota é o 1º comando" (D-F121, PADROES §11 regra 12) → 409 RESOURCE_BUSY
 * (refazer a operação abre um retrato novo DEPOIS da trava) — nunca "pegar a primeira".
 */
export async function lockInvoice(
  conn: PoolConnection, s: string, institutionId: number, invoiceId: number
): Promise<LockedInvoice> {
  const [rows] = await conn.query<any[]>(
    `SELECT id, number, serie, model, value, status
       FROM \`${s}\`.tb_invoice
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' FOR UPDATE`,
    [invoiceId, institutionId]
  )
  if (!rows[0]) {
    throw new HttpError(404, `Nota do pedido ${invoiceId} não encontrada`, undefined, 'INVOICE_NOT_FOUND')
  }
  const [life] = await conn.query<any[]>(
    `SELECT life_event AS lifeEvent, last_event AS lastEvent, last_kind AS lastKind
       FROM \`${s}\`.vw_invoice_life
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 LOCK IN SHARE MODE`,
    [institutionId, invoiceId]
  )
  if (life.length > 1) {
    throw new HttpError(409, `A nota ${rows[0].number ?? invoiceId} mudou durante a operação — tente novamente`,
      undefined, ErrorCodes.RESOURCE_BUSY)
  }
  const l = life[0]
  return {
    id: Number(rows[0].id), number: rows[0].number ?? null, serie: rows[0].serie ?? null,
    model: rows[0].model ?? null, value: Number(rows[0].value ?? 0), status: String(rows[0].status ?? ''),
    lifeEvent: l?.lifeEvent == null ? null : Number(l.lifeEvent),
    lastEvent: l?.lastEvent == null ? null : Number(l.lastEvent), lastKind: l?.lastKind ?? null,
  }
}

export interface InvoiceLife {
  invoiceId: number
  /** Cabeçalho soft-deletado (nota pendente cancelada — D3); os eventos ficam. */
  invoiceDeleted: boolean
  /** Evento E que abriu a VIDA vigente (D-N27); null = nota sem evento (sincronizada da origem). */
  lifeEvent: number | null
  lastEvent: number | null
  lastKind: string | null
}

function mapLife(r: any): InvoiceLife {
  return {
    invoiceId: Number(r.invoiceId), invoiceDeleted: String(r.invoiceDeleted) === 'S',
    lifeEvent: r.lifeEvent == null ? null : Number(r.lifeEvent),
    lastEvent: r.lastEvent == null ? null : Number(r.lastEvent), lastKind: r.lastKind ?? null,
  }
}

/**
 * Vida e último evento SEM trava (F2a A3 — leituras CONSULTIVAS: selo da lista de OS, efeito fiscal da tela), pela MESMA view de
 * política do `lockInvoice` (D-F32). Quem DECIDE usa o `lockInvoice` (trava + 1 linha exigida — D-F126). Lote = notas do mesmo
 * estabelecimento no terminal da web; nota sem linha (inexistente) não volta no mapa.
 */
export async function readInvoiceLives(
  q: Pick<PoolConnection, 'query'>, s: string, institutionId: number, invoiceIds: readonly number[]
): Promise<Map<number, InvoiceLife>> {
  const out = new Map<number, InvoiceLife>()
  if (!invoiceIds.length) return out
  const [rows] = await q.query<any[]>(
    `SELECT tb_invoice_id AS invoiceId, invoice_deleted AS invoiceDeleted, life_event AS lifeEvent,
            last_event AS lastEvent, last_kind AS lastKind
       FROM \`${s}\`.vw_invoice_life
      WHERE tb_institution_id = ? AND terminal = 0 AND tb_invoice_id IN (?)`,
    [institutionId, [...invoiceIds]]
  )
  for (const r of rows) {
    if (out.has(Number(r.invoiceId))) {
      // a view devolve 1 linha por nota; mais de uma = retrato torto (ver lockInvoice) — falha ALTO, nunca "a primeira"
      throw new HttpError(409, `A nota ${r.invoiceId} mudou durante a leitura — tente novamente`, undefined, ErrorCodes.RESOURCE_BUSY)
    }
    out.set(Number(r.invoiceId), mapLife(r))
  }
  return out
}

/**
 * Número MAX+1 por MODELO + SÉRIE (decisão R4-Q3) — D4: ignora notas com
 * `deleted='S'` (pendente cancelada libera o número; só reaproveita de fato
 * se a cancelada era a última — igual ao legado; número no meio vira
 * buraco para a inutilização da fase de transmissão).
 */
export async function nextInvoiceNumber(
  conn: PoolConnection, s: string, institutionId: number, model: string, serie: string
): Promise<string> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(number_seq), 0) + 1 AS nextNumber
       FROM \`${s}\`.tb_invoice
      WHERE tb_institution_id = ? AND model = ? AND serie = ? AND deleted = 'N' FOR UPDATE`,
    [institutionId, model, serie]
  )
  return String(mx[0].nextNumber)
}

export interface InvoiceMerchandiseInput {
  baseIcms: number
  icms: number
  baseIcmsSt: number
  icmsSt: number
  ipi: number
  totalValue: number
  freight: number
  expenses: number
  discount: number
  quantity: number
}

export interface InvoiceServiceInput {
  totalValue:    number
  serviceListId: string | null      // subitem LC 116 ('1.02')
  nationalCode:  string | null      // cTribNac (6 dígitos)
  municipalCode: string | null      // cTribMun
  cityId:        number | null      // cidade de INCIDÊNCIA (da regra)
  baseIss:       number             // Σ base de tb_order_item_issqn
  aliqIss:       number             // % da regra
  issValue:      number             // Σ ISS
  issWithheld:   'S' | 'N'          // tpRetISSQN (D-N8)
  liability:     '1' | '2' | '3' | '4'  // tribISSQN (D-N8)
  description:   string | null      // xDescServ montado dos itens
  /** Fase IBS/CBS, IB-2 (D-IB9/D-IB62/D-IB71): a DECLARAÇÃO IBS/CBS congelada no ramo — OBRIGATÓRIA (produtor que não
   *  decide não compila) e construída só pela peça `@shared/ibscbs-classification` (pela composição
   *  `@shared/service-ibscbs-declaration`). Grupo omitido = colunas NULL (o motivo nunca é gravado — D-IB65). */
  ibscbs:        IbscbsDeclaration
}

/** O ramo de serviço ANTES da declaração IBS/CBS — o que o produtor monta dos itens (ISS, códigos, descrição). */
export type InvoiceServiceDraft = Omit<InvoiceServiceInput, 'ibscbs'>

export interface IssueInvoiceInput {
  orderId: number
  recipientEntityId: number
  model: string
  serie: string
  totalValue: number
  noteText: string | null
  /** Ramo de mercadoria — presença = existe (natureza da nota por ramo). */
  merchandise: InvoiceMerchandiseInput | null
  /** Ramo de SERVIÇO (presença = ramo existe). Onda 3 (migration 058): o ramo
   *  carrega o que o DPS precisa, CONGELADO no faturamento — um DPS declara UM
   *  serviço (D-N2), por isso um único código nacional/municipal/cidade por nota. */
  service: InvoiceServiceInput | null
  /** D-IB64: data de EMISSÃO (= `dCompet` do DPS) — o produtor a calcula UMA vez (hoje do estabelecimento, Q-TZ1) e
   *  passa a MESMA à declaração IBS/CBS e aqui: `tb_invoice.dt_emission` e a data do evento E. */
  dtEmission: string
}

export interface IssuedInvoice {
  invoiceNumber: string
  event: number
}

/**
 * Emite a nota: cabeçalho (upsert com REVIVE — D3/D5), ramos por PRESENÇA
 * (upsert; ramo ausente nesta vida vira 'S'), evento E com snapshot.
 * Roda DENTRO da transação do faturamento (o chamador já travou o pedido).
 */
export async function issueInvoice(
  conn: PoolConnection, s: string, institutionId: number, userId: number,
  input: IssueInvoiceInput
): Promise<IssuedInvoice> {
  const invoiceNumber = await nextInvoiceNumber(conn, s, institutionId, input.model, input.serie)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_invoice
       (id, tb_institution_id, terminal, issuer, number, serie,
        tb_entity_id, dt_emission, value, model, status, note, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, '0', ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       issuer = VALUES(issuer), number = VALUES(number), serie = VALUES(serie),
       tb_entity_id = VALUES(tb_entity_id), dt_emission = VALUES(dt_emission), value = VALUES(value),
       model = VALUES(model), status = '0', note = VALUES(note), deleted = 'N', updated_at = NOW()`,
    [input.orderId, institutionId, institutionId, invoiceNumber, input.serie,
     input.recipientEntityId, input.dtEmission,   // D-IB64 (Q-TZ1): a data que o produtor calculou UMA vez
     input.totalValue, input.model, input.noteText || null]
  )
  if (input.merchandise) {
    const m = input.merchandise
    await conn.query(
      `INSERT INTO \`${s}\`.tb_invoice_merchandise
         (id, tb_institution_id, terminal, base_icms_value, icms_value,
          base_icms_st_value, icms_st_value, ipi_value, total_value,
          freight_value, insurance_value, expenses_value, discount_value,
          total_qtty, indPres, created_at, updated_at, deleted)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         base_icms_value = VALUES(base_icms_value), icms_value = VALUES(icms_value),
         base_icms_st_value = VALUES(base_icms_st_value), icms_st_value = VALUES(icms_st_value),
         ipi_value = VALUES(ipi_value), total_value = VALUES(total_value),
         freight_value = VALUES(freight_value), insurance_value = 0,
         expenses_value = VALUES(expenses_value), discount_value = VALUES(discount_value),
         total_qtty = VALUES(total_qtty), indPres = 0, deleted = 'N', updated_at = NOW()`,
      [input.orderId, institutionId, m.baseIcms, m.icms, m.baseIcmsSt, m.icmsSt, m.ipi,
       m.totalValue, m.freight, m.expenses, m.discount, m.quantity]
    )
  } else {
    await conn.query(
      `UPDATE \`${s}\`.tb_invoice_merchandise SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
      [input.orderId, institutionId]
    )
  }
  if (input.service) {
    const sv = input.service
    await conn.query(
      `INSERT INTO \`${s}\`.tb_invoice_service
         (id, tb_institution_id, terminal, total_value, tb_service_list_id, national_code, municipal_code,
          tb_city_id, base_iss_value, aliq_iss, iss_value, iss_withheld, liability, description,
          classification_code, place_indicator_code, nbs,
          created_at, updated_at, deleted)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         total_value = VALUES(total_value), tb_service_list_id = VALUES(tb_service_list_id),
         national_code = VALUES(national_code), municipal_code = VALUES(municipal_code),
         tb_city_id = VALUES(tb_city_id), base_iss_value = VALUES(base_iss_value),
         aliq_iss = VALUES(aliq_iss), iss_value = VALUES(iss_value), iss_withheld = VALUES(iss_withheld),
         liability = VALUES(liability), description = VALUES(description),
         classification_code = VALUES(classification_code), place_indicator_code = VALUES(place_indicator_code),
         nbs = VALUES(nbs),
         deleted = 'N', updated_at = NOW()`,   // F2a (D-F30/§22.5 item 4): dps_number APOSENTADA — o nDPS da vida é da nfse-api
      // D-IB71: as 3 colunas da declaração SEMPRE regravadas (inclusive NULL) — a nota REVIVIDA nunca herda a da 1ª vida.
      // ÚNICO escritor delas (cerca: ibscbs-declaration-fence.test.ts).
      [input.orderId, institutionId, sv.totalValue, sv.serviceListId, sv.nationalCode, sv.municipalCode,
       sv.cityId, sv.baseIss, sv.aliqIss, sv.issValue, sv.issWithheld, sv.liability, sv.description,
       sv.ibscbs.group?.classificationCode ?? null, sv.ibscbs.group?.placeIndicatorCode ?? null, sv.ibscbs.nbs]
    )
  } else {
    await conn.query(
      `UPDATE \`${s}\`.tb_invoice_service SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
      [input.orderId, institutionId]
    )
  }
  const event = await insertInvoiceEvent(conn, s, institutionId, input.orderId, userId, {
    kind: 'E', dtRecord: input.dtEmission,
    snapshot: { number: invoiceNumber, serie: input.serie, model: input.model, value: input.totalValue },
  })
  return { invoiceNumber, event }
}



/**
 * IB-3 (D-IB76): a declaração IBS/CBS CONGELADA no ramo de serviço da nota — o que o faturamento gravou (IB-2), lido para o detalhe
 * faturado; nunca recalculada. null = a nota não tem ramo de serviço vivo. Os campos null = o grupo/NBS não foram declarados.
 */
export interface FrozenIbscbsDeclaration {
  classificationCode: string | null
  placeIndicatorCode: string | null
  nbs:                string | null
}

export async function readFrozenIbscbs(
  q: { query: (sql: string, params?: unknown[]) => Promise<any> }, s: string, institutionId: number, invoiceId: number, terminal: number,
): Promise<FrozenIbscbsDeclaration | null> {
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`schema inválido: ${s}`)
  // gate socrático da IB-3 (L6): o TERMINAL do ramo da nota (o mesmo que liga a OS à nota) — nunca `terminal = 0` fixo
  const [rows] = await q.query(
    `SELECT classification_code AS classificationCode, place_indicator_code AS placeIndicatorCode, nbs
       FROM \`${s}\`.tb_invoice_service
      WHERE id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`,
    [invoiceId, institutionId, terminal])
  const r = (rows as any[])[0]
  return r ? { classificationCode: r.classificationCode ?? null, placeIndicatorCode: r.placeIndicatorCode ?? null, nbs: r.nbs ?? null } : null
}
