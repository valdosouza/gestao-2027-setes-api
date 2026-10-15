/**
 * PRÉ-VOO do faturamento IBS/CBS (fase IBS/CBS, IB-2 — D-IB52/D-IB55/D-IB72; prompt_fase_ibs_cbs.md §12.6) — script do
 * Super, SÓ LEITURA, todos os schemas (mesmo operador/credencial da carga do catálogo — D-IB32).
 *
 * Pergunta pela MESMA composição do faturamento (`evaluateServiceIbscbs`, modo só-pergunta, sem trava) — nunca um
 * predicado próprio (maquete nº 9 do §12.3) — e lista o que a nota faria:
 *   - universo (a) cada SERVIÇO ativo sozinho;
 *   - universo (b) os conjuntos REAIS por cliente: a OS ABERTA (trava D5) e os contratos VIGENTES na competência da data
 *     (o que o lote de janeiro vai faturar — pega a divergência da D-IB63, que o serviço sozinho não mostra).
 * Data (D-IB55): a da OBRIGAÇÃO do emitente enquanto ela não chegou; depois, a competência a faturar (hoje do
 * estabelecimento); `--data AAAA-MM-DD` sobrepõe. Ao lado, o veredito de HOJE e o selo do cadastro (D-IB37/D-IB40).
 * Rodar antes de 01/12/2026 e de novo antes de 01/01/2027 (D-IB72).
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/preflight-ibscbs.ts [--schema setes_x] [--data AAAA-MM-DD] [--tudo]
 *      (--tudo lista também o que já DECLARA; sem ele, só o que omite ou recusaria)
 */
import pool from '@shared/db/connection'
import { todayFor } from '@shared/time-zone'
import { evaluateServiceIbscbs } from '@shared/service-ibscbs-declaration'
import { emitterRegimeAt } from '@shared/entity-tax/entity-tax.repository'
import {
  MODEL_NFSE, ibscbsObligationStart, classificationAcceptance, nbsExists, IbscbsEvaluation,
} from '@shared/ibscbs-classification'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const ONLY_SCHEMA = arg('--schema')
const FORCED_DATE = arg('--data')
const ALL = process.argv.includes('--tudo')

/** Uma linha do relatório: o que a nota faria NA DATA e HOJE. */
function verdictText(ev: IbscbsEvaluation): string {
  if (ev.refusal) return `RECUSA 422 ${ev.refusal.code}`
  if (ev.declaration.group) return 'DECLARA o grupo'
  const nbs = ev.declaration.nbs ? ' (cNBS sozinha)' : ''
  return `OMITE o grupo [${ev.declaration.omitted.join(', ')}]${nbs}`
}

const isProblem = (ev: IbscbsEvaluation) => ev.refusal !== null || ev.declaration.group === null

async function main() {
  if (FORCED_DATE && !/^\d{4}-\d{2}-\d{2}$/.test(FORCED_DATE)) throw new Error(`--data inválida: ${FORCED_DATE}`)
  const [institutions] = await pool.query<any[]>(
    `SELECT id, schema_name AS s FROM setes_central.tb_institution WHERE deleted = 'N' ORDER BY schema_name`)
  let refusals = 0
  const regimeUnknown: string[] = []   // D-IB74: institutions SEM regime do Simples (vale a obrigação do não optante — JÁ)
  for (const inst of institutions as any[]) {
    const s = String(inst.s)
    const institutionId = Number(inst.id)
    if (ONLY_SCHEMA && s !== ONLY_SCHEMA) continue
    if (!/^[A-Za-z0-9_]+$/.test(s)) continue
    const today = await todayFor(s, institutionId)
    const regime = await emitterRegimeAt(pool, s, institutionId, today, { lock: false })
    const obligation = ibscbsObligationStart(MODEL_NFSE, regime)
    const date = FORCED_DATE ?? (today < obligation ? obligation : today)
    if (regime.simplesRegime === null) regimeUnknown.push(`${s} (institution ${institutionId})`)
    console.log(`\n=== ${s} (institution ${institutionId}) — opSimpNac ${regime.simplesRegime ?? 'desconhecido'} · `
      + `obrigação desde ${obligation} · pergunta NA DATA ${date} · hoje ${today}`)

    const ask = (items: { productId: number; field: string }[], d: string) =>
      evaluateServiceIbscbs(pool, s, institutionId, { items, competenceDate: d }, { lock: false })

    // (a) cada serviço ativo sozinho
    const [services] = await pool.query<any[]>(
      `SELECT p.id, p.description, sv.nbs, si.classification_code AS cls, si.place_indicator_code AS place
         FROM \`${s}\`.tb_product p
         LEFT JOIN \`${s}\`.tb_service sv ON sv.id = p.id AND sv.tb_institution_id = p.tb_institution_id AND sv.deleted = 'N'
         LEFT JOIN \`${s}\`.tb_service_ibscbs si ON si.id = p.id AND si.tb_institution_id = p.tb_institution_id AND si.deleted = 'N'
        WHERE p.tb_institution_id = ? AND p.kind = 'S' AND p.deleted = 'N' AND COALESCE(p.active, 'S') = 'S'
        ORDER BY p.id`, [institutionId])
    console.log(`-- (a) serviços ativos: ${(services as any[]).length}`)
    for (const sv of services as any[]) {
      const items = [{ productId: Number(sv.id), field: `product.${sv.id}` }]
      const atDate = await ask(items, date)
      if (atDate.refusal) refusals++
      if (!ALL && !isProblem(atDate)) continue
      const atToday = await ask(items, today)
      const seal = sv.cls
        ? await classificationAcceptance(pool, sv.cls, sv.place, today)
        : null
      const sealText = [
        seal ? `classificação ${seal.classification && seal.placeIndicator ? 'aceita' : 'NÃO aceita'} hoje` : 'sem classificação',
        sv.nbs ? `NBS ${(await nbsExists(pool, sv.nbs)) ? 'na lista' : 'FORA da lista'}` : 'sem NBS',
      ].join(' · ')
      console.log(`SERVIÇO ${sv.id} ${String(sv.description ?? '').slice(0, 40)}`
        + `\n    na data: ${verdictText(atDate)} | hoje: ${verdictText(atToday)} | selo: ${sealText}`
        + (atDate.refusal ? `\n    motivo: ${atDate.refusal.message}` : ''))
    }

    // (b) o conjunto REAL que o lote fatura, POR CLIENTE (gate socrático da IB-2): pela trava D5 a rotina mensal injeta os
    //     itens dos contratos na OS ABERTA do cliente — a nota leva a UNIÃO (OS aberta ∪ contratos vigentes na competência
    //     da data). Avaliar cada parte sozinha deixava passar a divergência (D-IB63) que só aparece na soma.
    const [openOs] = await pool.query<any[]>(
      `SELECT so.id AS orderId, os.tb_customer_id AS customerId, i.tb_product_id AS productId
         FROM \`${s}\`.tb_service_order so
         JOIN \`${s}\`.tb_order_service os ON os.id = so.id AND os.tb_institution_id = so.tb_institution_id AND os.terminal = 0
         JOIN \`${s}\`.tb_order_item i ON i.tb_order_id = so.id AND i.tb_institution_id = so.tb_institution_id
          AND i.terminal = 0 AND i.deleted = 'N'
        WHERE so.tb_institution_id = ? AND so.open_lock IS NOT NULL AND so.deleted = 'N'`, [institutionId])
    const month = date.slice(0, 7)
    const [contracts] = await pool.query<any[]>(
      `SELECT c.tb_customer_id AS customerId, i.tb_product_id AS productId
         FROM \`${s}\`.tb_contract c
         JOIN \`${s}\`.tb_contract_item i ON i.tb_contract_id = c.id AND i.tb_institution_id = c.tb_institution_id AND i.deleted = 'N'
        WHERE c.tb_institution_id = ? AND c.deleted = 'N' AND c.active = 'S'
          AND c.dt_start <= LAST_DAY(?) AND (c.dt_end IS NULL OR c.dt_end >= ?)`,
      [institutionId, `${month}-01`, `${month}-01`])
    const sets = new Map<string, { label: string; products: Set<number> }>()
    const add = (key: string, label: string, productId: number) => {
      const e = sets.get(key) ?? { label, products: new Set<number>() }
      e.products.add(productId)
      sets.set(key, e)
    }
    const osOf = new Map<number, number>()
    for (const r of openOs as any[]) osOf.set(Number(r.customerId), Number(r.orderId))
    const labelOf = (customerId: number) => {
      const os = osOf.get(customerId)
      return `cliente ${customerId} (${os ? `OS aberta ${os}` : 'sem OS aberta'} + contratos vigentes em ${month})`
    }
    for (const r of openOs as any[]) add(`cli:${r.customerId}`, labelOf(Number(r.customerId)), Number(r.productId))
    for (const r of contracts as any[]) add(`cli:${r.customerId}`, labelOf(Number(r.customerId)), Number(r.productId))
    console.log(`-- (b) conjuntos reais por cliente: ${sets.size} (OS aberta ∪ contratos vigentes — o que o lote fatura)`)
    for (const { label, products } of sets.values()) {
      const items = [...products].map(productId => ({ productId, field: `product.${productId}` }))
      const atDate = await ask(items, date)
      if (atDate.refusal) refusals++
      if (!ALL && !isProblem(atDate)) continue
      console.log(`${label} — serviços ${[...products].join(', ')}`
        + `\n    na data: ${verdictText(atDate)}`
        + (atDate.refusal ? `\n    motivo: ${atDate.refusal.message}` : ''))
    }
  }
  if (regimeUnknown.length > 0) {
    console.log(`\n⚠️ Regime do Simples NÃO informado (D-IB74 — vale a obrigação do não optante, 2026-10-01, JÁ): `
      + regimeUnknown.join(', '))
  }
  console.log(`\nRecusas (422) na data perguntada: ${refusals} — 0 é o alvo antes de ligar o lote de janeiro.`)
  await pool.end()
}

main().catch(async e => { console.error('FALHA', e?.message ?? e); await pool.end().catch(() => undefined); process.exit(1) })
