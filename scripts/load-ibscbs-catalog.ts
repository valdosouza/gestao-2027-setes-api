// =====================================================================
// Carga do catálogo IBS/CBS em setes_central (fase IBS/CBS, IB-1 —
// Infra-IA/prompts/prompt_fase_ibs_cbs.md §10.5 D-IB23 + §11 A-IB1/A-IB2).
//
// Fontes oficiais (arquivadas em Infra-IA/setes-api/integracoes/nfse-adn/):
//   --it       classificacao-ibs-cbs/it-2025-002-v1-70-cclasstrib.xlsx   (identidade, vigência, flag, aplicabilidade)
//   --indop    rtc-2026-10/anexovii-indop_ibscbs_v1-03-00-nt009.xlsx    (cIndOp)
//   NBS e a conferência do IT vêm da API de dados abertos da Calculadora
//   (ou de arquivos JSON salvos: --nbs-json / --calc-json — este aceita a lista da data
//   da carga OU um objeto { "AAAA-MM-DD": [lista], ... } com as demais datas de conferência).
//
// O ATO tem PLANO (gate socrático da IB-1): o ENSAIO (padrão — transação + ROLLBACK,
// contagens e chaves desativadas exatas) imprime o `plano` = hash das fontes lidas; o
// --vai só grava com `--plano <hash>` IGUAL ao das fontes lidas agora — se a Calculadora
// (ou o arquivo) mudou entre o ensaio e o ato, nada é gravado.
// A data padrão é o dia de Brasília (DEFAULT_TIME_ZONE — PADROES §10), nunca o dia UTC.
// Uso:
//   npx tsx --require tsconfig-paths/register scripts/load-ibscbs-catalog.ts \
//     --it <xlsx> --it-version "IT 2025.002 v1.70" --indop <xlsx> --indop-version "Anexo VII v1.03.00" \
//     [--date AAAA-MM-DD] [--nbs-json <arq>] [--calc-json <arq>] [--vai --plano <hash do ensaio>]
// =====================================================================
import fs from 'fs'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

import { readXlsx } from '@shared/xlsx/read-xlsx'
import { todayIn, DEFAULT_TIME_ZONE } from '@shared/time-zone'
import {
  parseItCatalog, parsePlaceIndicators, parseNbsList, parseCalculatorCodes, conferenceDates, isCalendarDate,
  reconcileWithCalculator, applyCatalog, catalogPlan, fileDigest, assertPlanArgs, assertPlanMatches,
} from '@shared/ibscbs-catalog'

const CALCULATOR = 'https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/api/calculadora'
const FETCH_TIMEOUT_MS = 30_000
const KNOWN = new Set(['--it', '--it-version', '--indop', '--indop-version', '--date', '--nbs-json', '--calc-json', '--vai', '--plano'])

function args(): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!KNOWN.has(a)) throw new Error(`argumento desconhecido: ${a} (o ato só grava com --vai; nada é presumido)`)
    if (a in out) throw new Error(`argumento repetido: ${a}`)
    if (a === '--vai') { out[a] = true; continue }
    const v = argv[++i]
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} exige valor`)
    out[a] = v
  }
  return out
}

/** Conexão NOVA por pedido: o servidor da Calculadora trava a 2ª requisição numa conexão
 *  reaproveitada (keep-alive — provado em 2026-10-10 na lista de NBS: 20 s sem resposta ×
 *  148 ms com `Connection: close`). Timeout explícito: fonte lenta falha alto, nunca pendura. */
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Connection: 'close' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Calculadora respondeu HTTP ${res.status} em ${url}`)
  return res.json()
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
  const plano = typeof a['--plano'] === 'string' ? a['--plano'] : undefined
  assertPlanArgs(vai, plano)   // peça @shared/ibscbs-catalog/plan (testada)
  const date = typeof a['--date'] === 'string' ? a['--date'] : todayIn(DEFAULT_TIME_ZONE)
  if (!isCalendarDate(date)) throw new Error('--date deve ser AAAA-MM-DD (data que existe no calendário)')

  const itBytes = fs.readFileSync(a['--it'] as string)
  const indopBytes = fs.readFileSync(a['--indop'] as string)
  const it = parseItCatalog(readXlsx(itBytes))
  const indop = parsePlaceIndicators(readXlsx(indopBytes))

  // Conferência POR DATA (A-IB2): a data da carga + a data de cada linha de vigência fora dela.
  const calcByDate = new Map<string, string[]>()
  if (typeof a['--calc-json'] === 'string') {
    const saved = JSON.parse(fs.readFileSync(a['--calc-json'], 'utf-8'))
    if (Array.isArray(saved)) calcByDate.set(date, parseCalculatorCodes(saved, date))
    else if (saved && typeof saved === 'object') {
      for (const [d, list] of Object.entries(saved)) {
        if (!isCalendarDate(d)) throw new Error(`--calc-json: chave "${d}" não é AAAA-MM-DD`)
        calcByDate.set(d, parseCalculatorCodes(list, d))
      }
    } else throw new Error('--calc-json: esperado array ou objeto { data: lista }')
  } else {
    for (const d of conferenceDates(it, date)) {
      calcByDate.set(d, parseCalculatorCodes(
        await fetchJson(`${CALCULATOR}/dados-abertos/classificacoes-tributarias/cbs-ibs?data=${d}`), d))
    }
  }
  const rec = reconcileWithCalculator(it, calcByDate, date)

  const nbsJson = typeof a['--nbs-json'] === 'string'
    ? JSON.parse(fs.readFileSync(a['--nbs-json'], 'utf-8'))
    : await fetchJson(`${CALCULATOR}/dados-abertos/nbs/lista?data=${date}`)
  const nbs = parseNbsList(nbsJson)

  // Plano = o que ESTA execução vai gravar (peça plan.ts — registros JÁ interpretados, não só bytes).
  const plan = catalogPlan({
    date, itFile: fileDigest(itBytes), it, itVersion: a['--it-version'] as string,
    indopFile: fileDigest(indopBytes), indop, indopVersion: a['--indop-version'] as string,
    unconfirmed: rec.unconfirmed, calculator: calcByDate, nbs,
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
      unconfirmed: rec.unconfirmed, models: ['SE'], apply: vai,
    })
    console.log(JSON.stringify({
      modo: report.applied ? 'GRAVADO' : `ENSAIO (rollback) — para gravar ESTE plano: --vai --plano ${plan}`,
      plano: plan,
      conferencia: rec,
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
