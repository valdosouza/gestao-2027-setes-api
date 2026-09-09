import { PoolConnection } from 'mysql2/promise'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'
import {
  settleOneTitle, findOpenCashierIdTx, insertStatement, nextSettledCode, StatementLine,
} from '@shared/financial-settlement'
import { reverseOnePayment, ReversalCore } from '@shared/financial-settlement/settlement-batch'
import { OPEN_BALANCE_SQL } from '@shared/financial-settlement/title-balance'
import { reverseStatementLines } from '@shared/financial-settlement/statement-reversal'

/**
 * Peça compartilhada do CHEQUE (migration 040 —
 * Infra-IA/prompts/prompt_cheque_rastreabilidade.md D1–D10 + D7a–c). Cheque
 * = título AO PORTADOR que substitui a dívida do cliente a partir da baixa
 * do faturamento: cabeçalho IMUTÁVEL (tb_check) + HISTÓRIA append-only
 * (tb_check_event — R recebido · B depositado · D descontado · P usado em
 * pagamento · T retornado com reembolso · F retornado bom · V devolvido ·
 * X estornado). Estado = derivado do ÚLTIMO evento, nunca coluna. Tudo
 * transaction-aware (1º parâmetro conn); consumida pelo módulo `checks` e
 * pelo billing (recebimento de cheques na baixa — D8).
 *
 * Nenhuma operação escreve movimento por conta própria: R/P reusam
 * `settleOneTitle` (título envolvido); B/D/T mintam o próprio `settled_code`
 * (`nextSettledCode`) e gravam linhas via `insertStatement` (sem título —
 * é MOVIMENTO puro, não baixa) e são estornados pela peça única
 * `reverseStatementLines` (Q-CH1); F não move dinheiro; V cria um título NOVO
 * (2º produtor do ramo financial, molde `generatePartnershipOrders`).
 */

export type CheckHeaderKind = 'P' | 'T' // próprio (do pagador) / terceiro
export type CheckEventKind = 'R' | 'B' | 'D' | 'P' | 'T' | 'F' | 'V' | 'X'
export type CheckState = 'custody' | 'bank' | 'factoring' | 'supplier' | 'refunded' | 'collection'

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** Estado derivado do último evento vigente do cheque (nunca coluna). */
export function stateFromLastEvent(kind: string | null | undefined): CheckState {
  switch (kind) {
    case 'B': return 'bank'
    case 'D': return 'factoring'
    case 'P': return 'supplier'
    case 'T': return 'refunded'
    case 'V': return 'collection'
    default: return 'custody' // null (novo) · R · F
  }
}

/** SQL do último evento vigente de um cheque (subquery reutilizável nas listas). */
export const LAST_CHECK_EVENT_KIND_SQL = (s: string, checkAlias = 'c') =>
  `(SELECT ev.kind FROM \`${s}\`.tb_check_event ev
     WHERE ev.tb_institution_id = ${checkAlias}.tb_institution_id
       AND ev.tb_check_id = ${checkAlias}.id AND ev.deleted = 'N'
     ORDER BY ev.event DESC LIMIT 1)`

/** Kind do evento que o ÚLTIMO evento (se for X) reverteu — null se o último não for X. */
export const LAST_CHECK_ORIGIN_KIND_SQL = (s: string, checkAlias = 'c') => `(
  SELECT o.kind FROM \`${s}\`.tb_check_event o
   WHERE o.tb_institution_id = ${checkAlias}.tb_institution_id AND o.tb_check_id = ${checkAlias}.id
     AND o.event = (SELECT ev.origin_event FROM \`${s}\`.tb_check_event ev
                     WHERE ev.tb_institution_id = ${checkAlias}.tb_institution_id
                       AND ev.tb_check_id = ${checkAlias}.id AND ev.deleted = 'N'
                     ORDER BY ev.event DESC LIMIT 1)
)`

/**
 * Estado para LISTAGEM/FILTRO, direto em SQL — mesma lógica do
 * `effectiveState()` (achado do gate adversarial 2026-09-04: X é META-evento,
 * não estado; reverter B/D/P volta pra custódia, reverter T/F volta pra
 * factoring). O R estornado sem "antes" cai em 'custody' aqui só por
 * pragmatismo de EXIBIÇÃO — quem de fato BLOQUEIA qualquer ação nele é
 * `effectiveState()` em memória (devolve 'voided', nenhum assert bate).
 */
export const LAST_CHECK_STATE_SQL = (s: string, checkAlias = 'c') => `(
  SELECT CASE ev.kind
      WHEN 'B' THEN 'bank' WHEN 'D' THEN 'factoring' WHEN 'P' THEN 'supplier'
      WHEN 'T' THEN 'refunded' WHEN 'V' THEN 'collection'
      WHEN 'X' THEN (SELECT CASE o.kind
          WHEN 'T' THEN 'factoring' WHEN 'F' THEN 'factoring' ELSE 'custody' END
        FROM \`${s}\`.tb_check_event o
       WHERE o.tb_institution_id = ev.tb_institution_id AND o.tb_check_id = ev.tb_check_id
         AND o.event = ev.origin_event)
      ELSE 'custody' END
    FROM \`${s}\`.tb_check_event ev
   WHERE ev.tb_institution_id = ${checkAlias}.tb_institution_id
     AND ev.tb_check_id = ${checkAlias}.id AND ev.deleted = 'N'
   ORDER BY ev.event DESC LIMIT 1
)`

function todayIso(): string {
  const d = new Date()
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-')
}

// ---------------------------------------------------------------------
// Cabeçalho (tb_check) — imutável; D5: identidade reusa o registro
// ---------------------------------------------------------------------

export interface CheckHeaderInput {
  bankId:  number
  agency:  string
  account: string
  number:  string
  issuer:  string
  value:   number
  dtCheck: string
  kind:    CheckHeaderKind
}

interface LockedCheck {
  id: number
  bankId: number
  agency: string
  account: string
  number: string
  value: number
  lastKind: string | null
  lastEvent: number | null
  /** Kind do evento que o último X reverteu (null se o último não for X). */
  lastOriginKind: string | null
}

/**
 * Achado do gate adversarial (2026-09-04, CRITICAL): X não é um estado, é
 * um META-evento — `stateFromLastEvent` mapeava 'X' pro `default` (mesmo
 * bucket de null/R/F = 'custody'), então um cheque cujo R foi estornado
 * virava "em custódia" de novo e podia ser depositado/descontado/pago sem
 * nenhum R por trás. Cada kind só é gravado sob uma PRECONDIÇÃO fixa (B/D/P
 * exigem custódia; T/F exigem factoring) — reverter esse evento devolve
 * exatamente essa precondição, nunca 'custody' por default. Reverter o
 * PRÓPRIO R não tem "antes" — o recebimento nunca aconteceu; 'voided' não é
 * um CheckState de verdade, então nenhuma ação bate nele.
 */
function effectiveState(check: LockedCheck): CheckState | 'voided' {
  if (check.lastKind !== 'X') return stateFromLastEvent(check.lastKind)
  switch (check.lastOriginKind) {
    case 'B': case 'D': case 'P': return 'custody'
    case 'T': case 'F': return 'factoring'
    default: return 'voided' // R (ou origem não resolvida) — nunca mais acionável
  }
}

/** Livre para receber um novo evento R (D5) — não está em custódia/banco/factoring/aguardando devolução. */
function isCheckFree(lastKind: string | null, lastOriginKind: string | null): boolean {
  if (lastKind == null || lastKind === 'P' || lastKind === 'V') return true
  // Decisão do Valdo (2026-09-04, rodada dos gates): R estornado (voided)
  // libera a identidade de novo — o recebimento original nunca aconteceu
  // de fato, então o operador corrige digitando o cheque certo sob o
  // MESMO papel, em vez de ficar travado para sempre.
  return lastKind === 'X' && lastOriginKind === 'R'
}

/**
 * D5: acha o cheque pela IDENTIDADE (banco/agência/conta/número) — existe e
 * está LIVRE → reusa o id (novo evento R sobre o MESMO registro); existe e
 * está ativo em algum lugar do fluxo → 409 (a mesma folha não pode estar em
 * dois lugares); não existe → cria (cabeçalho imutável a partir daqui).
 */
async function findOrCreateCheck(
  conn: PoolConnection, s: string, institutionId: number, header: CheckHeaderInput
): Promise<number> {
  // Achado da re-verificação socrática (2026-09-04): mesma classe de risco
  // já fechada para factoringEntityId — bankId vira cabeçalho IMUTÁVEL, sem
  // validar contra o catálogo central um id órfão ficaria errado para
  // sempre (a listagem só mostra bankLabel em branco, sem nunca acusar).
  const [bank] = await conn.query<any[]>(
    `SELECT 1 FROM setes_central.tb_bank WHERE id = ? AND deleted = 'N'`,
    [header.bankId]
  )
  if (bank.length === 0) {
    throw new HttpError(400, 'Banco inexistente',
      [{ field: 'bankId', message: 'Banco não encontrado' }], 'BANK_NOT_FOUND')
  }
  const [rows] = await conn.query<any[]>(
    `SELECT c.id, c.value, c.issuer, DATE_FORMAT(c.dt_check, '%Y-%m-%d') AS dtCheck,
            ${LAST_CHECK_EVENT_KIND_SQL(s)} AS lastKind,
            ${LAST_CHECK_ORIGIN_KIND_SQL(s)} AS lastOriginKind
       FROM \`${s}\`.tb_check c
      WHERE c.tb_institution_id = ? AND c.tb_bank_id = ? AND c.agency = ?
        AND c.account = ? AND c.number = ? AND c.deleted = 'N' FOR UPDATE`,
    [institutionId, header.bankId, header.agency, header.account, header.number]
  )
  if (rows[0]) {
    if (!isCheckFree(rows[0].lastKind, rows[0].lastOriginKind)) {
      throw new HttpError(409,
        `Cheque ${header.number} já está em uso (identidade duplicada)`,
        undefined, 'CHECK_ALREADY_ACTIVE')
    }
    const wasVoided = rows[0].lastKind === 'X' && rows[0].lastOriginKind === 'R'
    if (wasVoided) {
      // Decisão do Valdo (2026-09-04): o recebimento original nunca
      // aconteceu de fato (R estornado) — o cabeçalho gravado é o dado
      // ERRADO que motivou o estorno, então a correção do operador
      // ATUALIZA o cabeçalho para o cheque certo, em vez de compará-lo
      // contra o engano (a checagem de divergência abaixo só faz sentido
      // para um papel que já completou um ciclo real — P/V).
      await conn.query(
        `UPDATE \`${s}\`.tb_check SET issuer = ?, value = ?, dt_check = ?, kind = ?, updated_at = NOW()
          WHERE id = ? AND tb_institution_id = ?`,
        [header.issuer, header.value, header.dtCheck, header.kind, rows[0].id, institutionId]
      )
    } else if (Number(rows[0].value) !== header.value || rows[0].issuer !== header.issuer
        || rows[0].dtCheck !== header.dtCheck) {
      // Achado do gate adversarial (2026-09-04): cabeçalho é IMUTÁVEL fora
      // do caso acima — reusar a identidade livre (P/V) com valor/emitente/
      // data DIFERENTES do que já está gravado deixaria o cabeçalho
      // mentindo sobre o cheque físico. Reusar é só para o MESMO papel
      // voltando ao fluxo (D5), nunca outro papel com o mesmo número.
      throw new HttpError(409,
        `Cheque ${header.number} já cadastrado com dados diferentes (valor/emitente/data)`,
        undefined, 'CHECK_IDENTITY_MISMATCH')
    }
    return Number(rows[0].id)
  }
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${s}\`.tb_check
      WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )
  const id = Number(mx[0].nextId)
  try {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_check
         (id, tb_institution_id, tb_bank_id, agency, account, number, issuer,
          value, dt_check, kind, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
      [id, institutionId, header.bankId, header.agency, header.account, header.number,
       header.issuer, header.value, header.dtCheck, header.kind]
    )
  } catch (err: any) {
    // Corrida na identidade (D5): o SELECT...FOR UPDATE acima não bloqueia
    // uma linha que ainda não existe — duas transações concorrentes para o
    // MESMO cheque novo podem colidir na UNIQUE KEY. Devolve o 409 de
    // negócio já tratado, não um 500 cru.
    if (err?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409,
        `Cheque ${header.number} já está em uso (identidade duplicada)`,
        undefined, 'CHECK_ALREADY_ACTIVE')
    }
    throw err
  }
  return id
}

async function lockCheck(
  conn: PoolConnection, s: string, institutionId: number, checkId: number
): Promise<LockedCheck> {
  const [rows] = await conn.query<any[]>(
    `SELECT id, tb_bank_id AS bankId, agency, account, number, value
       FROM \`${s}\`.tb_check
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
    [checkId, institutionId]
  )
  if (!rows[0]) throw new HttpError(404, `Cheque ${checkId} não encontrado`, undefined, 'CHECK_NOT_FOUND')
  const [last] = await conn.query<any[]>(
    `SELECT t.event, t.kind,
            (SELECT o.kind FROM \`${s}\`.tb_check_event o
              WHERE o.tb_institution_id = t.tb_institution_id AND o.tb_check_id = t.tb_check_id
                AND o.event = t.origin_event) AS originKind
       FROM \`${s}\`.tb_check_event t
      WHERE t.tb_institution_id = ? AND t.tb_check_id = ? AND t.deleted = 'N'
      ORDER BY t.event DESC LIMIT 1 FOR UPDATE`,
    [institutionId, checkId]
  )
  return {
    id: Number(rows[0].id), bankId: Number(rows[0].bankId), agency: rows[0].agency,
    account: rows[0].account, number: rows[0].number, value: Number(rows[0].value),
    lastKind: last[0]?.kind ?? null, lastEvent: last[0] ? Number(last[0].event) : null,
    lastOriginKind: last[0]?.originKind ?? null,
  }
}

interface CheckEventInput {
  kind: CheckEventKind
  dtRecord: string
  entityId?: number | null
  settledCode?: number | null
  paymentEvent?: number | null
  orderId?: number | null
  terminal?: number | null
  parcel?: number | null
  bankAccountId?: number | null
  originEvent?: number | null
  note?: string | null
}

async function insertCheckEvent(
  conn: PoolConnection, s: string, institutionId: number, checkId: number,
  userId: number, e: CheckEventInput
): Promise<number> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(event), 0) + 1 AS nextEvent
       FROM \`${s}\`.tb_check_event
      WHERE tb_institution_id = ? AND tb_check_id = ? FOR UPDATE`,
    [institutionId, checkId]
  )
  const event = Number(mx[0].nextEvent)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_check_event
       (tb_institution_id, tb_check_id, event, kind, dt_record, tb_entity_id,
        settled_code, payment_event, tb_order_id, terminal, parcel,
        tb_bank_account_id, origin_event, note, tb_user_id,
        created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, checkId, event, e.kind, e.dtRecord, e.entityId ?? null,
     e.settledCode ?? null, e.paymentEvent ?? null, e.orderId ?? null,
     e.terminal ?? null, e.parcel ?? null, e.bankAccountId ?? null,
     e.originEvent ?? null, e.note ? String(e.note).slice(0, 255) : null, userId]
  )
  return event
}

// ---------------------------------------------------------------------
// R — recebido na baixa do faturamento (D1/D8/D9)
// ---------------------------------------------------------------------

export interface CheckReceiveItem extends CheckHeaderInput {}

export interface ReceiveChecksInput {
  orderId: number
  parcel: number
  dtPayment: string
  entityId: number | null // quem ENTREGOU (o cliente da ordem — D3 nota do parecer)
  checks: CheckReceiveItem[]
}

export interface ReceiveChecksResult {
  settledCode: number
  statementId: number
  checks: { id: number; event: number }[]
}

/**
 * D1: valor de FACE de todos os cheques da parcela entra na conta 0 (caixa)
 * numa ÚNICA baixa (D9: N eventos R sob o MESMO settled_code — soma dos
 * cheques = valor da parcela, validado pelo chamador ANTES/billing.service).
 * Exige caixa aberto — diferente do contrato financeiro (gate gracioso):
 * aqui o usuário JÁ digitou os dados do cheque, então sem caixa a operação
 * é recusada (409), não silenciosamente ignorada — não há outro jeito de o
 * cheque nascer no sistema (R só existe nesta transação).
 */
export async function receiveChecksOnBilling(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: ReceiveChecksInput
): Promise<ReceiveChecksResult> {
  const s = assertSchema(schemaName)
  if (input.checks.length === 0) {
    throw new HttpError(400, 'Informe ao menos um cheque',
      [{ field: 'checks', message: 'Obrigatório' }], 'CHECK_REQUIRED')
  }
  const cashierId = await findOpenCashierIdTx(conn, schemaName, institutionId, userId)
  if (cashierId === null) {
    throw new HttpError(409, 'Nenhum caixa aberto — abra o caixa para receber cheques',
      undefined, 'NO_OPEN_CASHIER')
  }
  const sum = round2(input.checks.reduce((acc, c) => acc + c.value, 0))
  const settle = await settleOneTitle(conn, schemaName, institutionId, userId, {
    orderId: input.orderId, parcel: input.parcel, paidValue: sum, dtPayment: input.dtPayment,
    bankAccountId: 0, cashierId,
    history: `Cheque(s) recebido(s) | Pedido ${input.orderId} parcela ${input.parcel}`,
  })
  const checks: { id: number; event: number }[] = []
  for (const c of input.checks) {
    const checkId = await findOrCreateCheck(conn, s, institutionId, c)
    const event = await insertCheckEvent(conn, s, institutionId, checkId, userId, {
      kind: 'R', dtRecord: input.dtPayment, entityId: input.entityId,
      settledCode: settle.settledCode, paymentEvent: settle.event,
      orderId: input.orderId, terminal: 0, parcel: input.parcel,
    })
    checks.push({ id: checkId, event })
  }
  return { settledCode: settle.settledCode, statementId: settle.statementId, checks }
}

// ---------------------------------------------------------------------
// B — depositado (cofre → banco)
// ---------------------------------------------------------------------

export interface DepositCheckInput {
  checkId: number
  dtRecord: string
  bankAccountId: number
}

function assertInCustody(check: LockedCheck): void {
  const state = effectiveState(check)
  if (state !== 'custody') {
    throw new HttpError(409, `Cheque ${check.id} não está em custódia (estado: ${state})`,
      undefined, 'CHECK_NOT_IN_CUSTODY')
  }
}

export async function depositCheck(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: DepositCheckInput
): Promise<{ event: number; settledCode: number }> {
  const s = assertSchema(schemaName)
  const check = await lockCheck(conn, s, institutionId, input.checkId)
  assertInCustody(check)
  if (!(input.bankAccountId > 0)) {
    throw new HttpError(400, 'Informe a conta de destino do depósito',
      [{ field: 'bankAccountId', message: 'Obrigatório' }], 'BANK_ACCOUNT_REQUIRED')
  }
  const [acc] = await conn.query<any[]>(
    `SELECT 1 FROM \`${s}\`.tb_bank_account WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [input.bankAccountId, institutionId]
  )
  if (acc.length === 0) {
    throw new HttpError(400, 'Conta bancária inexistente',
      [{ field: 'bankAccountId', message: 'Conta não encontrada' }], 'BANK_NOT_FOUND')
  }
  const cashierId = await findOpenCashierIdTx(conn, schemaName, institutionId, userId)
  if (cashierId === null) {
    throw new HttpError(409, 'Nenhum caixa aberto — abra o caixa para depositar', undefined, 'NO_OPEN_CASHIER')
  }
  const settledCode = await nextSettledCode(conn, s, institutionId)
  const history = `Depósito cheque ${check.number}`.slice(0, 100)
  const line = (over: Partial<StatementLine>): StatementLine => ({
    bankAccountId: 0, cashierId, dtRecord: input.dtRecord, dtOriginal: input.dtRecord,
    credit: 0, debit: 0, history, settledCode, userId, paymentTypeId: null, planCre: 0, planDeb: 0, ...over,
  })
  await insertStatement(conn, s, institutionId, line({ bankAccountId: 0, cashierId, debit: check.value }))
  await insertStatement(conn, s, institutionId, line({ bankAccountId: input.bankAccountId, cashierId: null, credit: check.value }))
  const event = await insertCheckEvent(conn, s, institutionId, check.id, userId, {
    kind: 'B', dtRecord: input.dtRecord, settledCode, bankAccountId: input.bankAccountId,
  })
  return { event, settledCode }
}

// ---------------------------------------------------------------------
// D — descontado na factoring (3 linhas, 1 código — fiel ao legado
// reg_ctrl_cheque.pas:385, sem os bugs de nome/histórico)
// ---------------------------------------------------------------------

export interface DiscountCheckInput {
  checkId: number
  dtRecord: string
  factoringEntityId: number
  bankAccountId: number // 0 = caixa; > 0 = conta
  feeValue: number       // ágio/custo — DIGITADO pelo usuário (legado não calcula %)
}

export async function discountCheck(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: DiscountCheckInput
): Promise<{ event: number; settledCode: number }> {
  const s = assertSchema(schemaName)
  const check = await lockCheck(conn, s, institutionId, input.checkId)
  assertInCustody(check)
  // Achado do gate adversarial (2026-09-04): factoringEntityId vira evento
  // IMUTÁVEL — sem checar tb_entity, qualquer inteiro era aceito e o
  // histórico do cheque passava a apontar pra um id órfão para sempre.
  const [factoring] = await conn.query<any[]>(
    `SELECT 1 FROM setes_central.tb_entity WHERE id = ?`,
    [input.factoringEntityId]
  )
  if (factoring.length === 0) {
    throw new HttpError(400, 'Entidade da factoring inexistente',
      [{ field: 'factoringEntityId', message: 'Entidade não encontrada' }], 'CHECK_FACTORING_NOT_FOUND')
  }
  if (input.bankAccountId > 0) {
    const [acc] = await conn.query<any[]>(
      `SELECT 1 FROM \`${s}\`.tb_bank_account WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [input.bankAccountId, institutionId]
    )
    if (acc.length === 0) {
      throw new HttpError(400, 'Conta bancária inexistente',
        [{ field: 'bankAccountId', message: 'Conta não encontrada' }], 'BANK_NOT_FOUND')
    }
  }
  const feeValue = round2(Math.max(0, input.feeValue))
  // linha 1 (cheque sai da custódia) SEMPRE na conta 0 -> exige caixa aberto
  const cashierId = await findOpenCashierIdTx(conn, schemaName, institutionId, userId)
  if (cashierId === null) {
    throw new HttpError(409, 'Nenhum caixa aberto — abra o caixa para descontar', undefined, 'NO_OPEN_CASHIER')
  }
  const destCashierId = input.bankAccountId === 0 ? cashierId : null
  const settledCode = await nextSettledCode(conn, s, institutionId)
  const history = `Desconto cheque ${check.number}`.slice(0, 100)
  const line = (over: Partial<StatementLine>): StatementLine => ({
    bankAccountId: 0, cashierId: null, dtRecord: input.dtRecord, dtOriginal: input.dtRecord,
    credit: 0, debit: 0, history, settledCode, userId, paymentTypeId: null, planCre: 0, planDeb: 0, ...over,
  })
  await insertStatement(conn, s, institutionId, line({ bankAccountId: 0, cashierId, debit: check.value }))
  await insertStatement(conn, s, institutionId,
    line({ bankAccountId: input.bankAccountId, cashierId: destCashierId, credit: check.value }))
  if (feeValue > 0) {
    await insertStatement(conn, s, institutionId, line({
      bankAccountId: input.bankAccountId, cashierId: destCashierId, debit: feeValue,
      history: `Taxa desconto cheque ${check.number}`.slice(0, 100),
    }))
  }
  const event = await insertCheckEvent(conn, s, institutionId, check.id, userId, {
    kind: 'D', dtRecord: input.dtRecord, entityId: input.factoringEntityId,
    settledCode, bankAccountId: input.bankAccountId,
  })
  return { event, settledCode }
}

// ---------------------------------------------------------------------
// T — retornado da factoring COM REEMBOLSO (D7a/D7c: dinheiro sai da
// empresa de volta pra factoring); F — retornado BOM sem movimento (D7b)
// ---------------------------------------------------------------------

export interface ReturnCheckRefundInput {
  checkId: number
  dtRecord: string
  bankAccountId: number // 0 = caixa; > 0 = conta
}

function assertDiscounted(check: LockedCheck): void {
  // effectiveState (não lastKind cru): um F estornado volta pra 'factoring'
  // (T/F só existem sob desconto vigente) — sem isso, o cheque ficava preso
  // (nem em custódia nem redescontável) depois de um estorno legítimo.
  if (effectiveState(check) !== 'factoring') {
    throw new HttpError(409, `Cheque ${check.id} não está descontado na factoring`,
      undefined, 'CHECK_NOT_DISCOUNTED')
  }
}

/** Busca o evento D vigente (para saber a factoring que devolveu). */
async function lastDiscountEntity(
  conn: PoolConnection, s: string, institutionId: number, checkId: number
): Promise<number | null> {
  const [rows] = await conn.query<any[]>(
    `SELECT tb_entity_id AS entityId FROM \`${s}\`.tb_check_event
      WHERE tb_institution_id = ? AND tb_check_id = ? AND kind = 'D' AND deleted = 'N'
      ORDER BY event DESC LIMIT 1`,
    [institutionId, checkId]
  )
  return rows[0]?.entityId == null ? null : Number(rows[0].entityId)
}

export async function returnCheckWithRefund(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: ReturnCheckRefundInput
): Promise<{ event: number; settledCode: number }> {
  const s = assertSchema(schemaName)
  const check = await lockCheck(conn, s, institutionId, input.checkId)
  assertDiscounted(check)
  const factoringEntityId = await lastDiscountEntity(conn, s, institutionId, check.id)

  let cashierId: number | null = null
  if (input.bankAccountId === 0) {
    cashierId = await findOpenCashierIdTx(conn, schemaName, institutionId, userId)
    if (cashierId === null) {
      throw new HttpError(409, 'Nenhum caixa aberto — abra o caixa para reembolsar', undefined, 'NO_OPEN_CASHIER')
    }
  } else {
    const [acc] = await conn.query<any[]>(
      `SELECT 1 FROM \`${s}\`.tb_bank_account WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [input.bankAccountId, institutionId]
    )
    if (acc.length === 0) {
      throw new HttpError(400, 'Conta bancária inexistente',
        [{ field: 'bankAccountId', message: 'Conta não encontrada' }], 'BANK_NOT_FOUND')
    }
  }
  const settledCode = await nextSettledCode(conn, s, institutionId)
  await insertStatement(conn, s, institutionId, {
    bankAccountId: input.bankAccountId, cashierId, dtRecord: input.dtRecord, dtOriginal: input.dtRecord,
    credit: 0, debit: check.value, history: `Reembolso cheque ${check.number} (sem fundos)`.slice(0, 100),
    settledCode, userId, paymentTypeId: null, planCre: 0, planDeb: 0,
  })
  const event = await insertCheckEvent(conn, s, institutionId, check.id, userId, {
    kind: 'T', dtRecord: input.dtRecord, entityId: factoringEntityId,
    settledCode, bankAccountId: input.bankAccountId,
  })
  return { event, settledCode }
}

export async function returnCheckGood(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, checkId: number, note?: string | null
): Promise<number> {
  const s = assertSchema(schemaName)
  const check = await lockCheck(conn, s, institutionId, checkId)
  assertDiscounted(check)
  const factoringEntityId = await lastDiscountEntity(conn, s, institutionId, check.id)
  // D7b: SEM movimento — o cheque volta à custódia (derivado: último ∈ {R,F}).
  return insertCheckEvent(conn, s, institutionId, check.id, userId, {
    kind: 'F', dtRecord: todayIso(), entityId: factoringEntityId, note: note ?? null,
  })
}

// ---------------------------------------------------------------------
// P — usado no contas a PAGAR (D2: move o caixa, exige caixa aberto)
// ---------------------------------------------------------------------

export interface UseCheckInPaymentInput {
  checkId: number
  dtRecord: string
  orderId: number // título PA a quitar
  parcel: number
}

export async function useCheckInPayment(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: UseCheckInPaymentInput
): Promise<{ event: number; settledCode: number }> {
  const s = assertSchema(schemaName)
  const check = await lockCheck(conn, s, institutionId, input.checkId)
  assertInCustody(check)
  // Achado do gate adversarial (2026-09-04): o cheque paga pelo valor de
  // FACE (não é um valor digitado com juízo — é o papel), então sem teto
  // um cheque de 500 quitava um título com saldo de 30 sem erro nem troco.
  // Q-G21: saldo em aberto pela peça ÚNICA (desconto abate)
  const [bal] = await conn.query<any[]>(
    `SELECT ${OPEN_BALANCE_SQL(s, 'f')} AS balance
       FROM \`${s}\`.tb_financial f
      WHERE f.tb_institution_id = ? AND f.tb_order_id = ? AND f.terminal = 0
        AND f.parcel = ? AND f.deleted = 'N' FOR UPDATE`,
    [institutionId, input.orderId, input.parcel]
  )
  if (!bal[0]) {
    throw new HttpError(404, `Título ${input.orderId}/${input.parcel} não encontrado`,
      undefined, 'TITLE_NOT_FOUND')
  }
  const balance = Number(bal[0].balance)
  if (check.value > balance) {
    throw new HttpError(422,
      `Cheque de ${check.value} excede o saldo aberto do título (${balance})`,
      [{ field: 'checkId', message: `Saldo aberto: ${balance}` }], 'CHECK_EXCEEDS_BALANCE')
  }
  const cashierId = await findOpenCashierIdTx(conn, schemaName, institutionId, userId)
  if (cashierId === null) {
    throw new HttpError(409, 'Nenhum caixa aberto — abra o caixa para pagar com cheque', undefined, 'NO_OPEN_CASHIER')
  }
  const [supplier] = await conn.query<any[]>(
    `SELECT COALESCE(ofn.tb_entity_id, NULL) AS entityId
       FROM \`${s}\`.tb_order_financial ofn
      WHERE ofn.id = ? AND ofn.tb_institution_id = ? AND ofn.terminal = 0`,
    [input.orderId, institutionId]
  )
  const settle = await settleOneTitle(conn, schemaName, institutionId, userId, {
    orderId: input.orderId, parcel: input.parcel, paidValue: check.value, dtPayment: input.dtRecord,
    bankAccountId: 0, cashierId, history: `Pagamento com cheque ${check.number}`,
  })
  const event = await insertCheckEvent(conn, s, institutionId, check.id, userId, {
    kind: 'P', dtRecord: input.dtRecord, entityId: supplier[0]?.entityId ?? null,
    settledCode: settle.settledCode, paymentEvent: settle.event,
    orderId: input.orderId, terminal: 0, parcel: input.parcel,
  })
  return { event, settledCode: settle.settledCode }
}

// ---------------------------------------------------------------------
// V — devolvido (sem fundos): NOVO título contra o cliente de ORIGEM
// (2º produtor do ramo financial — molde generatePartnershipOrders)
// ---------------------------------------------------------------------

export interface ReturnCheckInput {
  checkId: number
  dtRecord: string
  note?: string | null
}

export interface ReturnCheckResult {
  event: number
  orderId: number
}

function assertReturnable(check: LockedCheck): void {
  // pode bater direto na custódia/banco (devolvido ao depositar) ou depois
  // do reembolso da factoring (T) — nunca a partir de D/P/V/X.
  if (!['R', 'F', 'B', 'T'].includes(check.lastKind ?? '')) {
    throw new HttpError(409, `Cheque ${check.id} não pode ser devolvido no estado atual`,
      undefined, 'CHECK_NOT_RETURNABLE')
  }
}

export async function returnCheck(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: ReturnCheckInput
): Promise<ReturnCheckResult> {
  const s = assertSchema(schemaName)
  const check = await lockCheck(conn, s, institutionId, input.checkId)
  assertReturnable(check)

  // Achado do gate socrático (2026-09-04): devolvido a partir do BANCO
  // (depositado, nunca chegou a compensar) precisa desfazer o depósito —
  // senão o saldo da conta corrente fica inflado para sempre pelo valor
  // que nunca foi de fato recebido. Mesmo estorno usado pelo X de B.
  if (check.lastKind === 'B') {
    const [bankEvent] = await conn.query<any[]>(
      `SELECT settled_code AS settledCode FROM \`${s}\`.tb_check_event
        WHERE tb_institution_id = ? AND tb_check_id = ? AND kind = 'B' AND deleted = 'N'
        ORDER BY event DESC LIMIT 1`,
      [institutionId, check.id]
    )
    if (bankEvent[0]?.settledCode != null) {
      await reverseStatementLines(conn, s, institutionId, userId,
        Number(bankEvent[0].settledCode), `cheque ${check.number} devolvido sem fundos`,
        input.dtRecord)
    }
  }

  const [origin] = await conn.query<any[]>(
    `SELECT tb_entity_id AS entityId, payment_event AS paymentEvent,
            tb_order_id AS orderId, parcel
       FROM \`${s}\`.tb_check_event
      WHERE tb_institution_id = ? AND tb_check_id = ? AND kind = 'R' AND deleted = 'N'
      ORDER BY event DESC LIMIT 1`,
    [institutionId, check.id]
  )
  if (!origin[0]) {
    throw new HttpError(409, `Cheque ${check.id} sem evento de recebimento (R) — não é possível devolver`,
      undefined, 'CHECK_NO_ORIGIN')
  }
  const [orig] = await conn.query<any[]>(
    // Q-G19 (Valdo 2026-09-09): cheque MANTIDO de nota cancelada (D-G7a) volta
    // sem fundos — o título de origem está soft-deletado, mas a dívida é do
    // CHEQUE: só a forma de pagamento vem dele; o título CH nasce contra o
    // cliente de origem (tb_entity_id do R). Por isso SEM filtro de deleted.
    `SELECT f.tb_payment_types_id AS paymentTypeId
       FROM \`${s}\`.tb_financial f
      WHERE f.tb_institution_id = ? AND f.tb_order_id = ? AND f.terminal = 0
        AND f.parcel = ?`,
    [institutionId, origin[0].orderId, origin[0].parcel]
  )
  const paymentTypeId = orig[0] ? Number(orig[0].paymentTypeId) : null
  if (paymentTypeId == null) {
    throw new HttpError(409, 'Título de origem do cheque não encontrado', undefined, 'CHECK_NO_ORIGIN')
  }

  const [mxOrder] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${s}\`.tb_order WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )
  const newOrderId = Number(mxOrder[0].nextId)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_order
       (id, tb_institution_id, terminal, tb_user_id, dt_record, status, created_at, updated_at)
     VALUES (?, ?, 0, ?, CURDATE(), 'F', NOW(), NOW())`,
    [newOrderId, institutionId, userId]
  )
  await conn.query(
    `INSERT INTO \`${s}\`.tb_order_financial
       (id, tb_institution_id, terminal, tb_entity_id, tb_order_id_origin,
        origin_parcel, origin_event, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?, NOW(), NOW())`,
    [newOrderId, institutionId, origin[0].entityId, origin[0].orderId,
     origin[0].parcel, origin[0].paymentEvent]
  )
  await conn.query(
    `INSERT INTO \`${s}\`.tb_financial
       (tb_institution_id, tb_order_id, terminal, parcel, dt_expiration,
        tb_payment_types_id, tag_value, created_at, updated_at)
     VALUES (?, ?, 0, 1, ?, ?, ?, NOW(), NOW())`,
    [institutionId, newOrderId, input.dtRecord, paymentTypeId, check.value]
  )
  await conn.query(
    `INSERT INTO \`${s}\`.tb_financial_bills
       (tb_institution_id, tb_order_id, terminal, parcel, tb_financial_plans_id,
        number, kind, situation, operation, stage, created_at, updated_at)
     VALUES (?, ?, 0, 1, 0, ?, 'CH', 'N', 'C', 'N', NOW(), NOW())`,
    [institutionId, newOrderId, `${newOrderId}/CH-1`]
  )
  const event = await insertCheckEvent(conn, s, institutionId, check.id, userId, {
    kind: 'V', dtRecord: input.dtRecord, entityId: origin[0].entityId,
    orderId: newOrderId, terminal: 0, parcel: 1, note: input.note ?? null,
  })
  return { event, orderId: newOrderId }
}

// ---------------------------------------------------------------------
// X — estorno (D10: recusa se o cheque tem evento posterior)
// ---------------------------------------------------------------------

export interface ReverseCheckEventInput {
  checkId: number
  event: number
  reason: string
}

export interface ReverseCheckEventResult {
  event: number
  affectedCheckIds: number[]
  /**
   * D-G7 (cancelamento, Valdo 2026-09-09): quando o alvo é R/P a peça também
   * estorna a BAIXA do título — quem chamou por outra porta (tela de Baixas)
   * precisa do núcleo do estorno (evento/código) para compor a resposta.
   */
  core?: ReversalCore
}

/**
 * Q-P6 (cancelamento de nota, 2026-09-08 — refina a D10): um evento é
 * "vigente" quando nenhum evento POSTERIOR vivo o supera — pares
 * neutralizados por X (ex.: R → B → X(B)) não contam. Antes, o cheque que
 * foi depositado e teve o depósito estornado voltava à custódia mas nunca
 * mais tinha o R como último evento, e a nota ficava incancelável.
 */
export async function isCheckEventCurrent(
  conn: PoolConnection, s: string, institutionId: number, checkId: number, event: number
): Promise<boolean> {
  const [rows] = await conn.query<any[]>(
    `SELECT event, kind, origin_event AS originEvent
       FROM \`${s}\`.tb_check_event
      WHERE tb_institution_id = ? AND tb_check_id = ? AND event > ? AND deleted = 'N'
      ORDER BY event FOR UPDATE`,
    [institutionId, checkId, event]
  )
  // Gate adversarial (2026-09-09, CRITICAL): leitura TRAVANTE — sob
  // REPEATABLE READ o snapshot do cancelamento não via um depósito (B)
  // commitado no meio e estornava o R com o B vivo (cheque "em custódia"
  // com o dinheiro no banco, depositável de novo).
  const neutralized = new Set<number>(
    rows.filter(r => r.kind === 'X' && r.originEvent != null).map(r => Number(r.originEvent)))
  // Gate socrático C2 (2026-09-09): o PRÓPRIO alvo já estornado (existe X
  // apontando para ele) não é vigente — sem isto, um R da vida anterior da
  // nota entrava no cancelamento e "estornar X duas vezes" passava.
  if (neutralized.has(event)) return false
  return rows.every(r => r.kind === 'X' || neutralized.has(Number(r.event)))
}

export async function reverseCheckEvent(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: ReverseCheckEventInput
): Promise<ReverseCheckEventResult> {
  const s = assertSchema(schemaName)
  const check = await lockCheck(conn, s, institutionId, input.checkId)
  const [rows] = await conn.query<any[]>(
    `SELECT kind, settled_code AS settledCode, payment_event AS paymentEvent,
            tb_order_id AS orderId, parcel
       FROM \`${s}\`.tb_check_event
      WHERE tb_institution_id = ? AND tb_check_id = ? AND event = ? AND deleted = 'N'`,
    [institutionId, check.id, input.event]
  )
  const target = rows[0]
  // 404 antes do D10: evento inexistente não é "já avançou de estado".
  if (!target) throw new HttpError(404, `Evento ${input.event} não encontrado`, undefined, 'CHECK_EVENT_NOT_FOUND')
  // D10 refinada (Q-P6): "evento posterior VIGENTE" — pares B→X(B) não contam
  if (!(await isCheckEventCurrent(conn, s, institutionId, check.id, input.event))) {
    throw new HttpError(409,
      `Cheque ${check.id}: evento ${input.event} já foi estornado ou tem evento posterior vigente — estorne o mais recente primeiro`,
      undefined, 'CHECK_ALREADY_MOVED')
  }
  if (target.kind === 'X') {
    throw new HttpError(409, 'Evento de estorno não pode ser estornado', undefined, 'CHECK_EVENT_NOT_REVERSIBLE')
  }
  if (target.kind === 'V') {
    throw new HttpError(409, 'Estorno de devolução (V) não é suportado — cancele o título gerado',
      undefined, 'CHECK_EVENT_NOT_REVERSIBLE')
  }

  const dtRecord = todayIso()
  const affected = new Set<number>([check.id])
  let core: ReversalCore | undefined

  if (target.kind === 'R' || target.kind === 'P') {
    // D9: N cheques podem compartilhar o MESMO settled_code (mesma baixa de
    // parcela) — reverte o grupo inteiro junto, senão um irmão ficaria com
    // estado 'custódia' derivado de um R cuja baixa já foi desfeita.
    const [siblings] = await conn.query<any[]>(
      `SELECT tb_check_id AS checkId, event
         FROM \`${s}\`.tb_check_event
        WHERE tb_institution_id = ? AND settled_code = ? AND kind = ? AND deleted = 'N'
        ORDER BY tb_check_id`, // ordem determinística — reduz deadlock entre estornos concorrentes do mesmo grupo
      [institutionId, target.settledCode, target.kind]
    )
    // Achado do gate adversarial (2026-09-04, CRITICAL): D10 estendido ao
    // GRUPO — cada irmão só entra no estorno coletivo se ESTE ainda for o
    // evento mais recente dele. Sem isso, estornar o R de um cheque forçava
    // X também no irmão que já tinha sido depositado/pago, mentindo o
    // estado dele (voltava a 'custody' com o dinheiro ainda intocado no
    // banco) e reabrindo o título por inteiro mesmo com parte já resolvida.
    for (const sib of siblings) {
      if (Number(sib.checkId) === check.id) continue
      await lockCheck(conn, s, institutionId, Number(sib.checkId))
      if (!(await isCheckEventCurrent(conn, s, institutionId, Number(sib.checkId), Number(sib.event)))) {
        throw new HttpError(409,
          `Cheque ${sib.checkId} do mesmo recebimento já avançou de estado (depositado/descontado/usado) — este estorno é do EVENTO (D10, grupo inteiro em custódia); para desfazer a BAIXA use a tela de Baixas (D-G7a: cancela os em custódia e mantém os que transitaram)`,
          undefined, 'CHECK_ALREADY_MOVED')
      }
    }
    // Q-G20 (Valdo 2026-09-09): a baixa deste R/P pode já ter morrido por outra
    // porta (Baixas D-G7a deixou o cheque que transitou; depois o X do depósito
    // o trouxe de volta à custódia) — o X aqui só CANCELA o evento e libera a
    // identidade, sem tocar a baixa. Leitura travante (ordem cheque → payment).
    const [pay] = await conn.query<any[]>(
      `SELECT status FROM \`${s}\`.tb_financial_payment
        WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0 AND parcel = ? AND event = ?
        FOR UPDATE`,
      [institutionId, Number(target.orderId), Number(target.parcel), Number(target.paymentEvent)]
    )
    const paymentAlive = pay[0] != null && String(pay[0].status) === 'N'
    if (paymentAlive) {
      core = await reverseOnePayment(conn, schemaName, institutionId, userId,
        Number(target.orderId), Number(target.parcel), Number(target.paymentEvent),
        input.reason)
    }
    for (const sib of siblings) {
      affected.add(Number(sib.checkId))
      await insertCheckEvent(conn, s, institutionId, Number(sib.checkId), userId, {
        kind: 'X', dtRecord, settledCode: core ? core.settledCode : null,
        originEvent: Number(sib.event),
        note: core ? input.reason : `${input.reason} (baixa já estornada por outra porta — só o evento do cheque)`.slice(0, 100),
      })
    }
  } else if (target.kind === 'F') {
    await insertCheckEvent(conn, s, institutionId, check.id, userId, {
      kind: 'X', dtRecord, originEvent: input.event, note: input.reason,
    })
  } else {
    // B / D / T — movimento próprio, sem título: convenção única do extrato
    // (Q-CH1 — espelho 'R' com origem e dt_record herdado; original vira 'E')
    const reversalCode = await reverseStatementLines(
      conn, s, institutionId, userId, Number(target.settledCode), input.reason, dtRecord)
    await insertCheckEvent(conn, s, institutionId, check.id, userId, {
      kind: 'X', dtRecord, settledCode: reversalCode, originEvent: input.event, note: input.reason,
    })
  }
  return { event: input.event, affectedCheckIds: [...affected], ...(core ? { core } : {}) }
}

export interface ReversePaymentWithChecksInput {
  orderId: number
  parcel: number
  paymentEvent: number
  reason: string
}

export interface ReversePaymentWithChecksResult {
  core: ReversalCore
  /** Membros em custódia: R/P cancelado (X) — o cheque deixa de sustentar a baixa. */
  checksReversed: number[]
  /** Membros que já TRANSITARAM (depositado/descontado/usado): ficam como estão (D-G7a). */
  checksKept: number[]
}

/**
 * D-G7a (Valdo 2026-09-09): "cheque que já transitou não pode interferir em
 * momento algum". Estorno de uma BAIXA feita com cheque(s), pela tela de
 * Baixas: a baixa é desfeita UMA vez (reverseOnePayment); cada cheque do
 * grupo (D9 — um settled_code por parcela) que ainda está em CUSTÓDIA ganha
 * X do seu R/P (o "cancelamento" na linha do tempo — princípio "portador
 * substitui a dívida": a dívida volta ao título); o que já transitou fica
 * como está — o dinheiro é fato do mundo e a vida dele segue no módulo de
 * cheque. Diferente de `reverseCheckEvent` (tela de Cheques), que estorna um
 * EVENTO do cheque e exige o grupo inteiro em custódia (D10 por membro).
 *
 * Ordem de locks = a da peça: cheque → eventos → payment. A descoberta é
 * leitura simples; a vigência de cada membro é decidida sob lock. Devolve
 * null quando a baixa não foi feita com cheque.
 */
export async function reversePaymentWithChecks(
  conn: PoolConnection, schemaName: string, institutionId: number, userId: number,
  input: ReversePaymentWithChecksInput
): Promise<ReversePaymentWithChecksResult | null> {
  const s = assertSchema(schemaName)
  const [members] = await conn.query<any[]>(
    `SELECT e.tb_check_id AS checkId, e.event, e.kind
       FROM \`${s}\`.tb_check_event e
      WHERE e.tb_institution_id = ? AND e.tb_order_id = ? AND e.terminal = 0 AND e.parcel = ?
        AND e.payment_event = ? AND e.kind IN ('R', 'P') AND e.deleted = 'N'
        AND NOT EXISTS (SELECT 1 FROM \`${s}\`.tb_check_event x
                         WHERE x.tb_institution_id = e.tb_institution_id AND x.tb_check_id = e.tb_check_id
                           AND x.kind = 'X' AND x.origin_event = e.event AND x.deleted = 'N')
      ORDER BY e.tb_check_id, e.event`,
    [institutionId, input.orderId, input.parcel, input.paymentEvent]
  )
  if (members.length === 0) return null

  const inCustody: { checkId: number; event: number }[] = []
  const kept: number[] = []
  for (const m of members) {
    const checkId = Number(m.checkId)
    await lockCheck(conn, s, institutionId, checkId)
    if (await isCheckEventCurrent(conn, s, institutionId, checkId, Number(m.event))) {
      inCustody.push({ checkId, event: Number(m.event) })
    } else {
      kept.push(checkId)
    }
  }
  const core = await reverseOnePayment(conn, schemaName, institutionId, userId,
    input.orderId, input.parcel, input.paymentEvent, input.reason)
  const dtRecord = todayIso()
  for (const c of inCustody) {
    await insertCheckEvent(conn, s, institutionId, c.checkId, userId, {
      kind: 'X', dtRecord, settledCode: core.settledCode, originEvent: c.event, note: input.reason,
    })
  }
  return { core, checksReversed: inCustody.map(c => c.checkId), checksKept: kept }
}
