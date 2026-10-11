// =====================================================================
// Carga do catálogo IBS/CBS em setes_central (fase IBS/CBS, IB-1 —
// Infra-IA/prompts/prompt_fase_ibs_cbs.md §10.5 D-IB23 + §11 A-IB1/A-IB2 + §11.7 D-IB28/D-IB32).
// Procedimento de produção: Infra-IA/setes-api/skills/carregar-catalogo-ibscbs.md.
//
// Fontes oficiais (arquivadas em Infra-IA/setes-api/integracoes/nfse-adn/):
//   --it       classificacao-ibs-cbs/it-2025-002-v1-70-cclasstrib.xlsx   (identidade, vigência, flag, aplicabilidade)
//   --indop    rtc-2026-10/anexovii-indop_ibscbs_v1-03-00-nt009.xlsx    (cIndOp)
//   NBS e a conferência do IT vêm da API de dados abertos da Calculadora: a LISTA por data
//   (presença + documentos de cada código) e o PAR NFS-e × cClassTrib (aceitação + tributação
//   regular — D-IB28 (a)). Offline: --nbs-json / --calc-json, este com
//   { "AAAA-MM-DD": { "lista": [...], "pares": { "<cClassTrib>": {...} } } } (um array solto vale
//   como a lista da data da carga, sem pares — linha sem par conferido fica sem aplicabilidade).
//
// O ATO tem PLANO (gate socrático da IB-1): o ENSAIO (padrão — transação + ROLLBACK,
// contagens, chaves desativadas, divergências e impacto nos clientes) imprime o `plano` = hash
// do que será gravado; o --vai só grava com `--plano <hash>` IGUAL ao recalculado agora.
// Encolhimento > 10 % de qualquer lista = recusa, salvo --aceita-encolher (D-IB28 (c)).
// A data padrão é o dia de Brasília (DEFAULT_TIME_ZONE — PADROES §10), nunca o dia UTC.
// Uso:
//   npx tsx --require tsconfig-paths/register scripts/load-ibscbs-catalog.ts \
//     --it <xlsx> --it-version "IT 2025.002 v1.70" --indop <xlsx> --indop-version "Anexo VII v1.03.00" \
//     [--date AAAA-MM-DD] [--nbs-json <arq>] [--calc-json <arq>] [--aceita-encolher] [--vai --plano <hash do ensaio>]
// =====================================================================
import fs from 'fs'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

import { readXlsx } from '@shared/xlsx/read-xlsx'
import { todayIn, DEFAULT_TIME_ZONE } from '@shared/time-zone'
import {
  parseItCatalog, parsePlaceIndicators, parseNbsList, parseCalculatorList, parseCalculatorPair,
  conferenceDates, rowsNeedingPair, pairKey, isCalendarDate, CALCULATOR_NFSE_SIGLA,
  CalculatorEntry, CalculatorPair, reconcileWithCalculator, applyCatalog,
  catalogPlan, fileDigest, assertActDate, assertPlanArgs, assertPlanMatches,
} from '@shared/ibscbs-catalog'

const CALCULATOR = 'https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/api/calculadora'
const FETCH_TIMEOUT_MS = 30_000
const FETCH_ATTEMPTS = 4
const FETCH_PACING_MS = 250
const KNOWN = new Set(['--it', '--it-version', '--indop', '--indop-version', '--date', '--nbs-json', '--calc-json',
  '--aceita-encolher', '--vai', '--plano'])
const FLAGS = new Set(['--vai', '--aceita-encolher'])

function args(): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!KNOWN.has(a)) throw new Error(`argumento desconhecido: ${a} (o ato só grava com --vai; nada é presumido)`)
    if (a in out) throw new Error(`argumento repetido: ${a}`)
    if (FLAGS.has(a)) { out[a] = true; continue }
    const v = argv[++i]
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} exige valor`)
    out[a] = v
  }
  return out
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Conexão NOVA por pedido: o servidor da Calculadora trava a 2ª requisição numa conexão
 *  reaproveitada (keep-alive — provado em 2026-10-10: 20 s sem resposta × 148 ms com
 *  `Connection: close`). Ritmo + novas tentativas com espera crescente (a sequência de pares
 *  tem falhas transitórias — 4 em 70 no dia 10/10); esgotadas = fonte fora do ar → falha ALTA,
 *  nada gravado (nunca vira "código não aceito"). HTTP de erro não é repetido. */
async function fetchJson(url: string): Promise<unknown> {
  let last: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    await sleep(FETCH_PACING_MS)
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', Connection: 'close' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw Object.assign(new Error(`Calculadora respondeu HTTP ${res.status} em ${url}`), { final: true })
      return await res.json()
    } catch (err: any) {
      if (err?.final) throw err
      last = err
      await sleep(1000 * attempt)
    }
  }
  throw new Error(`Calculadora fora do ar (${FETCH_ATTEMPTS} tentativas) em ${url}: ${(last as Error)?.message ?? last}`)
}

async function main() {
  const a = args()
  for (const req of ['--it', '--it-version', '--indop', '--indop-version']) {
    if (!a[req]) throw new Error(`obrigatório: ${req}`)
  }
  for (const v of ['--it-version', '--indop-version']) {
    // source_version é VARCHAR(30) no DDL (script 61) — o modo estrito recusaria; avisa antes.
    if ((a[v] as string).length > 30) throw new Error(`${v} com mais de 30 caracteres`)
  }
  const vai = a['--vai'] === true
  const allowShrink = a['--aceita-encolher'] === true
  const plano = typeof a['--plano'] === 'string' ? a['--plano'] : undefined
  assertPlanArgs(vai, plano)   // peça @shared/ibscbs-catalog/plan (testada)
  const date = typeof a['--date'] === 'string' ? a['--date'] : todayIn(DEFAULT_TIME_ZONE)
  if (!isCalendarDate(date)) throw new Error('--date deve ser AAAA-MM-DD (data que existe no calendário)')
  assertActDate(vai, date, todayIn(DEFAULT_TIME_ZONE))   // D-IB48 (peça plan.ts, testada)

  const itBytes = fs.readFileSync(a['--it'] as string)
  const indopBytes = fs.readFileSync(a['--indop'] as string)
  const it = parseItCatalog(readXlsx(itBytes))
  const indop = parsePlaceIndicators(readXlsx(indopBytes))

  // Conferência POR DATA (A-IB2) com ATRIBUTOS (D-IB28 (a)): lista de cada data + pares NFS-e × cClassTrib.
  const entries = new Map<string, CalculatorEntry[]>()
  const pairs = new Map<string, CalculatorPair>()
  if (typeof a['--calc-json'] === 'string') {
    const saved = JSON.parse(fs.readFileSync(a['--calc-json'], 'utf-8'))
    if (Array.isArray(saved)) entries.set(date, parseCalculatorList(saved, date))
    else if (saved && typeof saved === 'object') {
      for (const [d, v] of Object.entries<any>(saved)) {
        if (!isCalendarDate(d)) throw new Error(`--calc-json: chave "${d}" não é AAAA-MM-DD`)
        const list = Array.isArray(v) ? v : v?.lista
        entries.set(d, parseCalculatorList(list, d))
        const pares = Array.isArray(v) ? {} : v?.pares ?? {}
        // estrutura dos pares (gate adversarial do delta): objeto { cClassTrib de 6 dígitos: par } — nunca array/string
        if (typeof pares !== 'object' || pares === null || Array.isArray(pares)) {
          throw new Error(`--calc-json: "pares" de ${d} deve ser um objeto { cClassTrib: par }`)
        }
        for (const [code, p] of Object.entries<any>(pares)) {
          if (!/^\d{6}$/.test(code)) throw new Error(`--calc-json: chave de par "${code}" (${d}) não é um cClassTrib de 6 dígitos`)
          pairs.set(pairKey(d, code), parseCalculatorPair(p, code, d))
        }
      }
    } else throw new Error('--calc-json: esperado array ou objeto { data: { lista, pares } }')
  } else {
    for (const d of conferenceDates(it, date)) {
      entries.set(d, parseCalculatorList(
        await fetchJson(`${CALCULATOR}/dados-abertos/classificacoes-tributarias/cbs-ibs?data=${d}`), d))
    }
    for (const { date: d, code } of rowsNeedingPair(it, entries, date)) {
      pairs.set(pairKey(d, code), parseCalculatorPair(await fetchJson(
        `${CALCULATOR}/dados-abertos/classificacoes-tributarias/cbs-ibs/${CALCULATOR_NFSE_SIGLA}/${code}?data=${d}`), code, d))
    }
  }
  const calculator = new Map([...entries].map(([d, l]) => [d, l.map(e => e.code)]))
  const calculatorNfse = new Map([...entries].map(([d, l]) => [d, l.filter(e => e.nfse).map(e => e.code)]))
  const rec = reconcileWithCalculator(it, calculator, date, { entries, pairs })

  const nbsJson = typeof a['--nbs-json'] === 'string'
    ? JSON.parse(fs.readFileSync(a['--nbs-json'], 'utf-8'))
    : await fetchJson(`${CALCULATOR}/dados-abertos/nbs/lista?data=${date}`)
  const nbs = parseNbsList(nbsJson)

  // Plano = o que ESTA execução vai gravar (peça plan.ts — registros JÁ interpretados, não só bytes).
  const plan = catalogPlan({
    date, itFile: fileDigest(itBytes), it, itVersion: a['--it-version'] as string,
    indopFile: fileDigest(indopBytes), indop, indopVersion: a['--indop-version'] as string,
    unconfirmed: rec.unconfirmed, calculator, nbs,
    calculatorNfse, pairs, blocked: rec.blocked, allowShrink,
  })
  assertPlanMatches(vai, plano, plan, date)

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    charset: 'utf8mb4', dateStrings: true, timezone: 'Z',
  })
  try {
    await conn.query(`SET time_zone = '+00:00'`)
    const report = await applyCatalog(conn, {
      it, itVersion: a['--it-version'] as string,
      placeIndicators: indop, indopVersion: a['--indop-version'] as string,
      nbs, nbsVersion: `Calculadora ${date}`,
      unconfirmed: rec.unconfirmed, blocked: rec.blocked, models: ['SE'],
      apply: vai, allowShrink, reportImpact: true, date,
    })
    const cmd = `--vai --plano ${plan}${allowShrink ? ' --aceita-encolher' : ''}`
    console.log(JSON.stringify({
      modo: report.applied ? 'GRAVADO'
        : date !== todayIn(DEFAULT_TIME_ZONE) ? 'ENSAIO (rollback) — reprodução com --date: este plano NÃO é gravável (o ato só aceita a data de hoje — D-IB48)'
        : `ENSAIO (rollback) — para gravar ESTE plano: ${cmd}`,
      plano: plan,
      ...(report.shrink.length && !allowShrink
        ? { AVISO_ENCOLHIMENTO: `o ato com --vai será RECUSADO (> 10 % das linhas vivas de alguma lista desativadas — na história, ausentes da fonte ou com a vigência encerrada) — confira o desdobramento em relatorio.shrink e, se for intencional, repita o ensaio com --aceita-encolher` }
        : {}),
      data: date,
      ...(date !== todayIn(DEFAULT_TIME_ZONE)
        ? { AVISO_DATA: `--date ${date} não é hoje: limite de encolhimento e impacto foram avaliados nessa data — use só para reproduzir uma carga (o ato com --vai recusa — D-IB48)` }
        : {}),
      conferencia: { ...rec, paresConsultados: pairs.size },
      fontes: { csts: it.csts.length, classificacoes: it.classifications.length, cIndOp: indop.length, nbs: nbs.length },
      relatorio: report,
    }, null, 2))
  } finally {
    await conn.end()
  }
}

main().catch(err => {
  console.error('[load-ibscbs-catalog] FALHA:', err.message ?? err)
  process.exit(1)
})
