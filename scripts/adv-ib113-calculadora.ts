/**
 * ADV D-IB113 (QA adversarial): só LEITURA da Calculadora oficial (GET, pausa entre chamadas) — repete a conferência D-IB28 (a)
 * da carga (lista por data + PAR por linha SE) e mostra: pares sem `exigeGrupoIbsCbs` (a carga inteira cairia), linhas bloqueadas
 * pelo motivo do grupo e a divergência IT × Calculadora por CST (inclusive das linhas que a lista já não aceita).
 */
import fs from 'fs'
import path from 'path'
import { readXlsx } from '@shared/xlsx/read-xlsx'
import { todayIn, DEFAULT_TIME_ZONE } from '@shared/time-zone'
import {
  parseItCatalog, parseCalculatorList, conferenceDates, rowsNeedingPair, pairKey, CALCULATOR_NFSE_SIGLA, CalculatorEntry, CalculatorPair,
  reconcileWithCalculator, conferenceDateOf,
} from '@shared/ibscbs-catalog'
const CALC = 'https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/api/calculadora'
const IT = path.resolve(__dirname, '../../../Infra-IA/setes-api/integracoes/nfse-adn/classificacao-ibs-cbs/it-2025-002-v1-70-cclasstrib.xlsx')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function get(url: string): Promise<any> {
  await sleep(300)
  const res = await fetch(url, { headers: { Accept: 'application/json', Connection: 'close' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}
async function main() {
  const it = parseItCatalog(readXlsx(fs.readFileSync(IT)))
  const date = process.argv[2] ?? todayIn(DEFAULT_TIME_ZONE)
  const cst = new Map(it.csts.map(c => [c.id, c.requiresGroup]))
  const entries = new Map<string, CalculatorEntry[]>()
  for (const d of conferenceDates(it, date)) entries.set(d, parseCalculatorList(await get(`${CALC}/dados-abertos/classificacoes-tributarias/cbs-ibs?data=${d}`), d))
  console.log('datas:', [...entries.keys()].join(', '))
  const pairs = new Map<string, CalculatorPair>()
  const raw: Record<string, any> = {}
  const missingField: string[] = []
  // TODA linha do IT (não só SE) na data de conferência — para ver o atributo do grupo por cClassTrib
  const all = new Map<string, { date: string; code: string }>()
  for (const r of it.classifications) { const d = conferenceDateOf(r, date); all.set(pairKey(d, r.code), { date: d, code: r.code }) }
  const need = new Set(rowsNeedingPair(it, entries, date).map(p => pairKey(p.date, p.code)))
  const divergeAll: string[] = []
  for (const { date: d, code } of all.values()) {
    let x: any
    try { x = await get(`${CALC}/dados-abertos/classificacoes-tributarias/cbs-ibs/${CALCULATOR_NFSE_SIGLA}/${code}?data=${d}`) }
    catch (e: any) { console.log(`  ${code}@${d}: ${e.message}${need.has(pairKey(d, code)) ? '  <-- PAR EXIGIDO PELA CARGA' : ''}`); continue }
    raw[pairKey(d, code)] = x
    if (typeof x?.exigeGrupoIbsCbs !== 'boolean') { missingField.push(`${code}@${d} need=${need.has(pairKey(d, code))} ${JSON.stringify(x).slice(0, 160)}`); continue }
    if (need.has(pairKey(d, code))) pairs.set(pairKey(d, code), { valid: x.validoParaSiglaDfeInformado, requiresRegular: x.exigeGrupoTributacaoRegular, requiresGroup: x.exigeGrupoIbsCbs })
    if (x.exigeGrupoIbsCbs !== cst.get(code.slice(0, 3))) divergeAll.push(`${code}@${d} IT(CST ${code.slice(0, 3)})=${cst.get(code.slice(0, 3)) ? 1 : 0} × Calc=${x.exigeGrupoIbsCbs ? 1 : 0} valido=${x.validoParaSiglaDfeInformado}`)
  }
  console.log(`pares consultados: ${Object.keys(raw).length}; exigidos pela carga: ${need.size}`)
  console.log(`sem exigeGrupoIbsCbs booleano: ${missingField.length}`); missingField.slice(0, 20).forEach(s => console.log('  ', s))
  console.log(`divergência do grupo IT × Calculadora (todas as linhas): ${divergeAll.length}`); divergeAll.forEach(s => console.log('  ', s))
  const calculator = new Map([...entries].map(([d, l]) => [d, l.map(e => e.code)]))
  const rec = reconcileWithCalculator(it, calculator, date, { entries, pairs })
  const grp = rec.blocked.filter(b => /grupo IBS\/CBS/.test(b.reason))
  console.log(`reconcile: blocked=${rec.blocked.length} (grupo: ${grp.length}) unconfirmed=${rec.unconfirmed.length}`)
  rec.blocked.forEach(b => console.log('   blocked', b.code, b.validFrom, b.conferredAt, b.reason))
  const sample = Object.entries(raw).slice(0, 2)
  console.log('amostra:', JSON.stringify(sample).slice(0, 1500))
  fs.writeFileSync(path.join(process.env.ADV_OUT ?? '.', 'adv-ib113-calc-raw.json'), JSON.stringify(raw, null, 1))
}
main().catch(e => { console.error('FALHA', e?.stack ?? e); process.exit(1) })
