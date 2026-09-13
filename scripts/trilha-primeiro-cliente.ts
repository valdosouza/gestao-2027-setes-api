/**
 * TRILHA DO PRIMEIRO CLIENTE (Setes) — tracking de entrega de ponta a ponta.
 * Fase: Infra-IA/prompts/prompt_primeiro_cliente_setes.md (Onda 0).
 *
 * Percorre os 7 processos do rascunho do Valdo na ORDEM REAL do negócio e
 * reporta, por etapa: OK (funciona), FALHA (quebrou — tem que consertar) ou
 * PENDENTE (não existe ainda; a onda que entrega está no detalhe).
 *
 * A trilha é a RÉGUA da fase: cada onda seguinte tem que virar um PENDENTE em
 * OK sem quebrar nenhum OK anterior. Por isso ela roda contra a API DE VERDADE
 * (HTTP), e não contra funções internas — as leituras diretas no banco só
 * conferem o que a API não devolve e resolvem os lookups auxiliares.
 *
 * USO (com a API no ar):
 *   npx tsx --require tsconfig-paths/register scripts/trilha-primeiro-cliente.ts
 *   ... --only=P0        # só a conferência de implantação (não cria nada)
 *   ... --base=http://localhost:3000
 *
 * A trilha CRIA dados no schema alvo (serviço, contrato, parceria, OS, nota,
 * título, boleto) e imprime os ids no fim para conferência/limpeza. Não roda
 * contra produção: recusa se NODE_ENV=production.
 */
import 'dotenv/config'
import jwt from 'jsonwebtoken'
import pool from '@shared/db/connection'

type Status = 'OK' | 'FALHA' | 'PENDENTE'

interface Linha {
  codigo:  string
  processo: string
  status:  Status
  detalhe: string
}

const linhas: Linha[] = []
const criados: Record<string, unknown> = {}

function reporta(codigo: string, processo: string, status: Status, detalhe: string): void {
  linhas.push({ codigo, processo, status, detalhe })
  const selo = status === 'OK' ? '  OK  ' : status === 'FALHA' ? ' FALHA' : 'PENDEN'
  console.log(`[${selo}] ${codigo.padEnd(4)} ${processo.padEnd(34)} ${detalhe}`)
}

// ───────────────────────────── argumentos ─────────────────────────────

const args = process.argv.slice(2)
const arg  = (nome: string): string | undefined =>
  args.find(a => a.startsWith(`--${nome}=`))?.split('=').slice(1).join('=')

const BASE    = arg('base') ?? 'http://localhost:3000'
const SCHEMA  = arg('schema') ?? 'setes_setes'
const INST    = Number(arg('institution') ?? 1)
const USER    = Number(arg('user') ?? 1)
const ONLY    = arg('only')?.toUpperCase()

const rodar = (codigo: string): boolean => !ONLY || ONLY === codigo

// ───────────────────────────── infraestrutura ─────────────────────────────

const token = jwt.sign(
  { institutionId: INST, userId: USER, role: 'super', schemaName: SCHEMA },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' }
)

interface Resposta { status: number; body: any }

async function api(metodo: string, caminho: string, corpo?: unknown): Promise<Resposta> {
  const res = await fetch(`${BASE}/api${caminho}`, {
    method:  metodo,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  })
  let body: any = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, body }
}

/** Mensagem curta de uma resposta de erro (o envelope da API é {error, code, fields}). */
function motivo(r: Resposta): string {
  const b = r.body ?? {}
  const campos = Array.isArray(b.fields) && b.fields.length
    ? ` [${b.fields.map((f: any) => f.field ?? f.name ?? '?').join(', ')}]`
    : ''
  return `HTTP ${r.status} ${b.code ?? ''} ${b.error ?? ''}${campos}`.trim()
}

async function uma<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const [rows] = await pool.query<any[]>(sql, params)
  return (rows[0] as T) ?? null
}

// ───────────────────────── P0 — conferência de implantação ─────────────────────────

/**
 * As 6 tarefas de implantação acumuladas (§10.3 do prompt_cancelamento_nota.md).
 * Nenhuma delas é código: são configurações que, faltando, derrubam o 1º dia do
 * cliente com 403/422 sem erro de programação nenhum.
 */
async function p0(): Promise<void> {
  // 1. max_parcels das formas de pagamento (D-N1): DEFAULT 1 trava 2+ parcelas.
  // O limite é do VÍNCULO institution × forma (schema do cliente), não do catálogo central.
  const formas = await pool.query<any[]>(
    `SELECT pt.id, pt.description, pt.kind, v.max_parcels
       FROM \`${SCHEMA}\`.tb_institution_has_payment_types v
       INNER JOIN setes_central.tb_payment_types pt
          ON pt.id = v.tb_payment_types_id AND pt.deleted = 'N'
      WHERE v.tb_institution_id = ? AND v.enable = 'S' AND v.deleted = 'N'
      ORDER BY pt.id`, [INST]
  ).then(([r]) => r)
  const travadas = formas.filter(f => Number(f.max_parcels ?? 1) <= 1)
  reporta('P0.1', 'max_parcels das formas',
    travadas.length === formas.length ? 'PENDENTE' : 'OK',
    travadas.length
      ? `${travadas.length}/${formas.length} forma(s) com limite 1 — parcelamento bloqueado: ${travadas.map(f => f.description).join(', ')}`
      : `${formas.length} formas configuradas`)

  // 2. Privilégios de AÇÃO (FATURAR 5 / CANCELAR 7) para usuários REGULARES.
  const regulares = await uma<any>(
    `SELECT COUNT(*) q FROM \`${SCHEMA}\`.tb_user_has_privilege
      WHERE tb_privilege_id IN (5, 7) AND active = 'S' AND deleted = 'N'`)
  reporta('P0.2', 'privilégios FATURAR/CANCELAR',
    Number(regulares?.q ?? 0) > 0 ? 'OK' : 'PENDENTE',
    Number(regulares?.q ?? 0) > 0
      ? `${regulares.q} vínculo(s) ativo(s)`
      : 'nenhum usuário regular fatura/cancela — só admin/super passam (403 PRIVILEGE_REQUIRED)')

  // 3. Catálogo central da política de desconto (seed 55) — pré-requisito do app.
  const desconto = await uma<any>(
    `SELECT COUNT(*) q FROM setes_central.tb_interface_has_privilege
      WHERE tb_privilege_id = 8 AND active = 'S' AND deleted = 'N'`)
  reporta('P0.3', 'política de desconto (seed 55)',
    Number(desconto?.q ?? 0) >= 2 ? 'OK' : 'PENDENTE',
    `privilégio DESCONTO vinculado a ${desconto?.q ?? 0} interface(s) — esperado 2 (settlements + bank-charge-agreements)`)

  // 4. Teto do desconto: 0 (default) = ninguém dá desconto sem o privilégio 8.
  const teto = await uma<any>(
    `SELECT content FROM \`${SCHEMA}\`.tb_institution_has_config
      WHERE tb_institution_id = ? AND name = 'max_discount_aliquot'
        AND tb_user_id = 0 AND deleted = 'N'`, [INST])
  reporta('P0.4', 'teto do desconto configurado',
    teto ? 'OK' : 'PENDENTE',
    teto ? `max_discount_aliquot = ${teto.content}%`
         : 'sem valor na institution → default 0: operador regular recebe 403 ao dar qualquer desconto')

  // 5. Boleto automático no faturamento (config auto_bank_slip da interface billing).
  const autoSlip = await uma<any>(
    `SELECT content FROM \`${SCHEMA}\`.tb_institution_has_config
      WHERE tb_institution_id = ? AND name = 'auto_bank_slip'
        AND tb_user_id = 0 AND deleted = 'N'`, [INST])
  // ⚠️ A expectativa AQUI é o contrário do óbvio (rodada 3, 2026-09-13): os dois
  //    caminhos do boleto são EXCLUDENTES — título com boleto vigente recusa
  //    outro. Com `auto_bank_slip` ligada, cada parcela já sai com boleto
  //    próprio e o AGRUPAMENTO manual (2 faturamentos num boleto só) fica
  //    impossível. O processo da Setes é o manual, então a chave fica DESLIGADA.
  const ligado = autoSlip?.content === 'S'
  reporta('P0.5', 'boleto automático DESLIGADO',
    ligado ? 'PENDENTE' : 'OK',
    ligado
      ? 'auto_bank_slip = S — cada parcela sai com boleto próprio e o agrupamento manual fica bloqueado'
      : `auto_bank_slip = ${autoSlip?.content ?? '(sem valor → default N)'} — o boleto sai do financeiro, agrupável`)

  // 6. REGRA DE RECEBIMENTO por forma (ex-"contrato financeiro" — renomeada em
  //    2026-09-13 justamente para não se confundir com o CONTRATO DE
  //    MENSALIDADE do cliente, que é o P3): a PRESENÇA dela é o gatilho da baixa.
  const regras = await uma<any>(
    `SELECT COUNT(*) q FROM \`${SCHEMA}\`.tb_settlement_rule
      WHERE tb_institution_id = ? AND deleted = 'N'`, [INST])
  reporta('P0.6', 'regras de recebimento por forma',
    Number(regras?.q ?? 0) > 0 ? 'OK' : 'PENDENTE',
    `${regras?.q ?? 0} forma(s) com regra — sem regra o título nasce ABERTO (nunca bloqueia o faturamento)`)

  // 7b. Forma de BOLETO: o automatismo dispara pelo `kind='B'` da forma, não
  //     pelo nome. Forma chamada "BOLETO" com kind 'O' nunca emite boleto —
  //     achado da Onda 1 no dev (2026-09-13).
  const formaBoleto = formas.filter(f => f.kind === 'B')
  reporta('P0.8', "forma de pagamento kind='B'",
    formaBoleto.length > 0 ? 'OK' : 'PENDENTE',
    formaBoleto.length
      ? `${formaBoleto.map(f => f.description).join(', ')}`
      : `nenhuma forma habilitada com kind='B' — o boleto automático nunca dispara (nome não conta): ${formas.map(f => `${f.description}=${f.kind}`).join(', ')}`)

  // 7. Carteira de cobrança: sem ela não há boleto (nem interno, nem no banco).
  const carteira = await uma<any>(
    `SELECT COUNT(*) q FROM \`${SCHEMA}\`.tb_bank_charge_agreement
      WHERE tb_institution_id = ? AND active = 'S' AND deleted = 'N'`, [INST])
  reporta('P0.7', 'carteira de cobrança ativa',
    Number(carteira?.q ?? 0) > 0 ? 'OK' : 'PENDENTE',
    `${carteira?.q ?? 0} carteira(s) ativa(s)`)
}

// ───────────────────────── lookups auxiliares ─────────────────────────

interface Apoio {
  categoryId?:       number
  priceListId?:      number
  serviceTaxRuleId?: number
  collaboratorId?:   number
  customerId?:       number
  paymentTypeId?:    number
}

async function apoio(): Promise<Apoio> {
  const um = async (sql: string, p: unknown[] = []) =>
    (await uma<any>(sql, p))?.id as number | undefined
  return {
    categoryId: await um(
      `SELECT id FROM \`${SCHEMA}\`.tb_category WHERE tb_institution_id = ? AND deleted = 'N' ORDER BY id LIMIT 1`, [INST]),
    priceListId: await um(
      `SELECT id FROM \`${SCHEMA}\`.tb_price_list WHERE tb_institution_id = ? AND deleted = 'N' ORDER BY id LIMIT 1`, [INST]),
    serviceTaxRuleId: await um(
      `SELECT id FROM \`${SCHEMA}\`.tb_service_tax_rule WHERE tb_institution_id = ? AND active = 'S' AND deleted = 'N' ORDER BY id LIMIT 1`, [INST]),
    collaboratorId: await um(
      `SELECT id FROM \`${SCHEMA}\`.tb_collaborator WHERE tb_institution_id = ? AND active = 'S' AND deleted = 'N' ORDER BY id LIMIT 1`, [INST]),
    customerId: await um(
      `SELECT id FROM \`${SCHEMA}\`.tb_customer WHERE tb_institution_id = ? AND deleted = 'N' ORDER BY id DESC LIMIT 1`, [INST]),
    // A Setes cobra contrato por BOLETO: prefere uma forma kind='B' habilitada
    // (é ela que exercita o processo 6); sem nenhuma, cai na forma que tem
    // regra de recebimento, que exercita a baixa automática.
    paymentTypeId: await um(
      `SELECT pt.id
         FROM \`${SCHEMA}\`.tb_institution_has_payment_types v
         INNER JOIN setes_central.tb_payment_types pt
            ON pt.id = v.tb_payment_types_id AND pt.deleted = 'N'
        WHERE v.tb_institution_id = ? AND v.enable = 'S' AND v.deleted = 'N'
          AND pt.kind = 'B' ORDER BY pt.id LIMIT 1`, [INST])
      ?? await um(
      `SELECT sr.tb_payment_types_id AS id FROM \`${SCHEMA}\`.tb_settlement_rule sr
        WHERE sr.tb_institution_id = ? AND sr.deleted = 'N' ORDER BY sr.tb_payment_types_id LIMIT 1`, [INST]),
  }
}

// ───────────────────────── P1..P7 — os processos ─────────────────────────

async function p1_servico(a: Apoio): Promise<number | null> {
  if (!a.categoryId) { reporta('P1', 'Cadastro de serviços', 'FALHA', 'nenhuma categoria no schema — o serviço exige categoria'); return null }
  if (!a.serviceTaxRuleId) { reporta('P1', 'Cadastro de serviços', 'FALHA', 'nenhuma regra de tributação de serviço ativa — sem ela o faturamento bloqueia'); return null }

  const r = await api('POST', '/services', {
    description:      `TRILHA Suporte mensal ${Date.now()}`,
    categoryId:       a.categoryId,
    serviceTaxRuleId: a.serviceTaxRuleId,
    active:           'S',
    prices:           a.priceListId ? [{ priceListId: a.priceListId, priceTag: 250 }] : [],
  })
  if (r.status !== 201) { reporta('P1', 'Cadastro de serviços', 'FALHA', motivo(r)); return null }
  const id = Number(r.body?.data?.id)
  criados.servicoId = id
  reporta('P1', 'Cadastro de serviços', 'OK', `serviço ${id} com regra de ISS ${a.serviceTaxRuleId}`)
  return id
}

async function p2_cliente(a: Apoio): Promise<number | null> {
  if (!a.customerId) { reporta('P2', 'Cadastro de clientes', 'FALHA', 'nenhum cliente no schema'); return null }
  const r = await api('GET', `/customers/${a.customerId}`)
  if (r.status !== 200) { reporta('P2', 'Cadastro de clientes', 'FALHA', motivo(r)); return null }
  const total = await uma<any>(
    `SELECT COUNT(*) q FROM \`${SCHEMA}\`.tb_customer WHERE tb_institution_id = ? AND deleted = 'N'`, [INST])
  reporta('P2', 'Cadastro de clientes', 'OK',
    `${total?.q} cliente(s) no schema; trilha usa o ${a.customerId} (D4: a carga vem do sincronizador)`)
  return a.customerId
}

async function p3_contrato(customerId: number, produtoId: number, a: Apoio): Promise<number | null> {
  const hoje = new Date()
  const dtStart = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`
  const r = await api('POST', '/contracts', {
    customerId, dtStart, dtEnd: null, paymentDay: 10,
    paymentTypeId: a.paymentTypeId ?? null,     // D14: a forma é do contrato
    active: 'S',
    items: [{ productId: produtoId, value: 250 }],
  })
  if (r.status !== 201) { reporta('P3', 'Contrato de mensalidade', 'FALHA', motivo(r)); return null }
  const id = Number(r.body?.data?.id)
  criados.contratoId = id
  reporta('P3', 'Contrato de mensalidade', 'OK',
    `contrato ${id} do cliente ${customerId}, vigente desde ${dtStart}, 1 item de R$ 250,00/mês`)
  return id
}

async function p4_parceria(customerId: number, a: Apoio): Promise<void> {
  if (!a.collaboratorId) { reporta('P4', 'Cadastro de parcerias', 'FALHA', 'nenhum colaborador ativo — a parceria é angariação por colaborador'); return }
  const r = await api('PUT', `/customers/${customerId}/partnership`, {
    partners: [{ collaboratorId: a.collaboratorId, rate: 20, active: 'S' }],
  })
  if (r.status !== 200 && r.status !== 201) { reporta('P4', 'Cadastro de parcerias', 'FALHA', motivo(r)); return }
  criados.parceiroId = a.collaboratorId
  reporta('P4', 'Cadastro de parcerias', 'OK',
    `colaborador ${a.collaboratorId} a 20% no cliente ${customerId} — vira ordem PA na baixa do recebimento`)
}

async function p5_cobranca_lote(clienteId: number): Promise<number | null> {
  const hoje = new Date()
  const r = await api('POST', '/service-orders/monthly-run', {
    year: hoje.getFullYear(), month: hoje.getMonth() + 1,
  })
  if (r.status !== 200 && r.status !== 201) { reporta('P5', 'Cobrança mensal (abertura)', 'FALHA', motivo(r)); return null }
  const rel = r.body?.data ?? r.body
  reporta('P5', 'Cobrança mensal (abertura)', 'OK',
    `processados ${rel?.processed}, abertas ${rel?.opened}, itens injetados ${rel?.injected}, pulados ${rel?.skipped}, erros ${rel?.errors?.length ?? 0}`)

  // A OS ABERTA do cliente DESTA trilha — nunca "a última do schema": com
  // outras provas rodando no mesmo dev, a última podia já estar faturada e a
  // trilha acusava falha que não era do produto (achado da própria trilha).
  const os = await uma<any>(
    `SELECT so.id FROM \`${SCHEMA}\`.tb_order_service so
       INNER JOIN \`${SCHEMA}\`.tb_order o
          ON o.id = so.id AND o.tb_institution_id = so.tb_institution_id
         AND o.terminal = 0
      WHERE so.tb_institution_id = ? AND so.tb_customer_id = ?
        AND o.status = 'A' AND o.deleted = 'N'
      ORDER BY so.id DESC LIMIT 1`, [INST, clienteId])
  if (os) criados.ordemServicoId = Number(os.id)
  else reporta('P5a', 'OS aberta do cliente da trilha', 'FALHA',
    `a rotina não deixou ordem ABERTA para o cliente ${clienteId}`)

  return criados.ordemServicoId as number ?? null
}

async function p6_faturamento(ordemId: number, a: Apoio): Promise<boolean> {
  if (!a.paymentTypeId) { reporta('P6', 'Faturamento da cobrança', 'FALHA', 'nenhuma forma habilitada com regra de recebimento ou boleto'); return false }
  // A cobrança mensal fatura em LOTE (D6/D7) — é assim que o processo roda de
  // verdade; a rota de uma ordem só continua existindo para o caso avulso.
  // SEM dtExpiration: cada ordem vence no dia do SEU contrato (D13) — é o modo
  // normal da mensalidade, e é o que a régua tem que provar.
  // SEM dtExpiration e SEM paymentTypeId: as duas condições vêm do contrato
  // de cada ordem (D13 + D14) — é assim que a cobrança mensal roda.
  const r = await api('POST', '/service-orders/batch-invoice', {
    orderIds: [ordemId], parcels: 1,
  })
  if (r.status !== 200) { reporta('P6', 'Faturamento da cobrança (lote)', 'FALHA', motivo(r)); return false }

  const rel = r.body?.data
  criados.faturamento = rel
  const linha = rel?.results?.[0]
  if (!linha?.ok) {
    reporta('P6', 'Faturamento da cobrança (lote)', 'FALHA',
      `lote respondeu 200, mas a ordem ${ordemId} não faturou: ${linha?.code ?? '?'} ${linha?.error ?? ''}`)
    return false
  }
  reporta('P6', 'Faturamento da cobrança (lote)', 'OK',
    `pedidas ${rel.requested}, faturadas ${rel.invoiced}, recusadas ${rel.failed} — nota ${linha.invoiceNumber}`)

  // D13: o vencimento veio do DIA DO CONTRATO da ordem, não de uma data do lote.
  const contrato = await uma<any>(
    `SELECT c.payment_day AS dia, c.tb_payment_types_id AS forma
       FROM \`${SCHEMA}\`.tb_contract c
      WHERE c.id = ? AND c.tb_institution_id = ?`, [criados.contratoId, INST])
  const diaUsado = Number(String(linha.dtExpiration ?? '').slice(8, 10))
  const okDia   = contrato && diaUsado === Number(contrato.dia)
  const okForma = contrato && Number(linha.paymentTypeId) === Number(contrato.forma)
  reporta('P6c', 'Condições do contrato (D13/D14)',
    okDia && okForma ? 'OK' : 'FALHA',
    contrato
      ? `contrato: dia ${contrato.dia} forma ${contrato.forma} → título: ${linha.dtExpiration} forma ${linha.paymentTypeId}`
      : 'contrato da trilha não encontrado')

  // D7: a MESMA ordem no lote de novo tem que sair recusada COM MOTIVO, sem
  // derrubar o lote — é o comportamento que sustenta a cobrança em massa.
  const rr = await api('POST', '/service-orders/batch-invoice', {
    orderIds: [ordemId], parcels: 1,
  })
  const recusa = rr.body?.data?.results?.[0]
  reporta('P6b', 'Lote segue e reporta (D7)',
    rr.status === 200 && recusa?.ok === false ? 'OK' : 'FALHA',
    rr.status === 200 && recusa?.ok === false
      ? `refaturar a mesma ordem volta recusada com motivo (${recusa.code ?? 's/ código'}) e HTTP 200`
      : `esperado 200 com a ordem recusada; veio ${motivo(rr)}`)
  return true
}

async function p7_boleto(ordemId: number | null): Promise<void> {
  if (ordemId == null) {
    reporta('P7', 'Boleto (do financeiro)', 'FALHA', 'sem ordem faturada para cobrar')
    return
  }

  // O boleto sai do FINANCEIRO, não do faturamento (processo do Valdo,
  // rodada 3): o título nasce e depois se decide como a dívida será cobrada —
  // inclusive juntando parcelas ou faturamentos num boleto só.
  const carteira = await uma<any>(
    `SELECT id FROM \`${SCHEMA}\`.tb_bank_charge_agreement
      WHERE tb_institution_id = ? AND active = 'S' AND deleted = 'N'
      ORDER BY id LIMIT 1`, [INST])
  if (!carteira) {
    reporta('P7', 'Boleto (do financeiro)', 'PENDENTE', 'nenhuma carteira de cobrança ativa')
    reporta('P7b', 'Boleto → Banco Inter', 'PENDENTE', PENDENCIA_INTER)
    return
  }

  const formaAntes = await uma<any>(
    `SELECT tb_payment_types_id AS forma FROM \`${SCHEMA}\`.tb_financial
      WHERE tb_institution_id = ? AND tb_order_id = ? AND parcel = 1 AND deleted = 'N'`,
    [INST, ordemId])

  const r = await api('POST', '/bank-slips', {
    agreementId: Number(carteira.id),
    titles: [{ orderId: ordemId, parcel: 1 }],
  })
  if (r.status !== 201) {
    reporta('P7', 'Boleto (do financeiro)', 'FALHA', motivo(r))
    reporta('P7b', 'Boleto → Banco Inter', 'PENDENTE', PENDENCIA_INTER)
    return
  }
  criados.boletoId = r.body?.data?.id
  reporta('P7', 'Boleto (do financeiro)', 'OK',
    `boleto ${r.body?.data?.id} do título ${ordemId}/1, nosso número ${r.body?.data?.ourNumber}, valor ${r.body?.data?.value}`)

  // D15: emitir DESTINA o título — a forma dele passa a dizer "boleto", que é
  // o que a baixa vai gravar no pagamento.
  const formaDepois = await uma<any>(
    `SELECT f.tb_payment_types_id AS forma, pt.kind
       FROM \`${SCHEMA}\`.tb_financial f
       INNER JOIN setes_central.tb_payment_types pt ON pt.id = f.tb_payment_types_id
      WHERE f.tb_institution_id = ? AND f.tb_order_id = ? AND f.parcel = 1 AND f.deleted = 'N'`,
    [INST, ordemId])
  reporta('P7a', 'Título destinado ao boleto (D15)',
    formaDepois?.kind === 'B' ? 'OK' : 'FALHA',
    `forma do título ${formaAntes?.forma} → ${formaDepois?.forma} (kind ${formaDepois?.kind})`)

  reporta('P7b', 'Boleto → Banco Inter', 'PENDENTE', PENDENCIA_INTER)
}

const PENDENCIA_INTER =
  'o boleto existe só aqui: falta registrar no Inter (OAuth2 + mTLS), guardar as DUAS referências ' +
  '(seuNumero nosso × codigoSolicitacao do banco), trazer linha digitável/PDF/QR Pix e baixar por webhook — Onda 2'

async function p8_nfse(ordemId: number | null): Promise<void> {
  // A nota da OS faturada: tb_invoice.id = tb_order.id (a nota VINCULA o processo)
  // e o ramo de serviço é a PRESENÇA da linha em tb_invoice_service.
  const nota = ordemId == null ? null : await uma<any>(
    `SELECT i.id, i.number, i.serie, i.model, i.value, s.total_value AS serviceValue
       FROM \`${SCHEMA}\`.tb_invoice i
       INNER JOIN \`${SCHEMA}\`.tb_invoice_service s
          ON s.id = i.id AND s.tb_institution_id = i.tb_institution_id AND s.deleted = 'N'
      WHERE i.tb_institution_id = ? AND i.id = ? AND i.deleted = 'N'`, [INST, ordemId])
  const cabecalho = ordemId == null ? null : await uma<any>(
    `SELECT id, number, serie, model, value FROM \`${SCHEMA}\`.tb_invoice
      WHERE tb_institution_id = ? AND id = ? AND deleted = 'N'`, [INST, ordemId])
  reporta('P8', 'Nota da OS (cabeçalho)', cabecalho ? 'OK' : 'PENDENTE',
    cabecalho ? `nota ${cabecalho.id} nº ${cabecalho.number}/${cabecalho.serie} modelo ${cabecalho.model}, valor ${cabecalho.value}`
              : `nenhuma nota para a ordem ${ordemId ?? '-'}`)
  reporta('P8a', 'Nota da OS (ramo de serviço)', nota ? 'OK' : 'PENDENTE',
    nota ? `ramo presente, serviço ${nota.serviceValue}`
         : 'a OS fatura com serviceTotal: null — a nota nasce SEM tb_invoice_service, logo sem base de ISS para a NFS-e — Onda 3')

  reporta('P8b', 'NFS-e (emissão fiscal)', 'PENDENTE',
    'não existe emissão: sem DPS/XML, transmissão ao ADN nacional, protocolo, DANFSe nem cancelamento por evento — Onda 3 (D1)')
}

async function p9_producao(): Promise<void> {
  reporta('P9', 'Produção (SaveInCloud)', 'PENDENTE',
    'sem empacotamento, deploy, HTTPS, backup ou monitoramento; domínios erp/api-erp.setesgestao.com.br a registrar — Onda 4 (D3)')
}

// ───────────────────────────── execução ─────────────────────────────

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('A trilha CRIA dados — não roda contra produção.')
    process.exit(2)
  }

  console.log(`\nTRILHA DO PRIMEIRO CLIENTE — ${BASE} · schema ${SCHEMA} · institution ${INST}\n`)

  await p0()
  if (ONLY === 'P0') return

  const saude = await api('GET', '/core/menus').catch(() => null)
  if (!saude || saude.status >= 500 || saude.status === 0) {
    reporta('API', 'API no ar', 'FALHA', `sem resposta útil de ${BASE} — suba a API (npm run dev)`)
    return
  }

  const a = await apoio()
  let ordemFaturada: number | null = null
  const servicoId = rodar('P1') ? await p1_servico(a) : null
  const clienteId = await p2_cliente(a)
  if (servicoId && clienteId) {
    const contratoId = await p3_contrato(clienteId, servicoId, a)
    await p4_parceria(clienteId, a)
    if (contratoId) {
      const ordemId = await p5_cobranca_lote(clienteId)
      if (ordemId && await p6_faturamento(ordemId, a)) ordemFaturada = ordemId
    }
  }
  await p7_boleto(ordemFaturada)
  await p8_nfse(ordemFaturada)
  await p9_producao()
}

main()
  .catch(err => { console.error('\nTRILHA ABORTOU:', err?.message ?? err); process.exitCode = 1 })
  .finally(async () => {
    const ok   = linhas.filter(l => l.status === 'OK').length
    const pend = linhas.filter(l => l.status === 'PENDENTE').length
    const bad  = linhas.filter(l => l.status === 'FALHA').length
    console.log(`\n─── RESUMO: ${ok} OK · ${pend} PENDENTE · ${bad} FALHA ───`)
    if (Object.keys(criados).length) {
      console.log('Criado pela trilha (conferir/limpar):', JSON.stringify(criados))
    }
    if (bad > 0) process.exitCode = 1
    await pool.end()
  })
