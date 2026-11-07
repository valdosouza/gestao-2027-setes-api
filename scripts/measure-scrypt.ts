/**
 * MEDIÇÃO do hash da senha (Onda 4 do endurecer — D-EA9/D-EA17/D-EA18; §P.5 H8 e H11 do `Infra-IA/prompts/prompt_endurecer_autenticacao.md`).
 * Roda a PEÇA real (`@shared/auth/password` — `checkPassword`, o mesmo cálculo do login) e mede, para o peso VIGENTE e para os pesos de
 * comparação: p50/p95/p99 de UMA verificação de cada vez; p50/p95/p99 com 20 verificações EM PARALELO (20 logins chegando juntos — o pool
 * do libuv tem 4 threads, as outras esperam); o pico de memória do processo (RSS) durante o paralelo; e a CAPACIDADE (verificações por
 * segundo) contra o limite de 300 requisições/min por IP. Nada de banco, nada gravado. A H11 é rodar ESTE script no SERVIDOR REAL (D-EA17):
 * o resultado decide o peso final e o piso das recusas (D-EA35 / Q-EA43).
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/measure-scrypt.ts [--amostras 30] [--paralelo 20] [--so-vigente]
 */
import os from 'os'
import { performance } from 'perf_hooks'
import {
  checkPassword, hashPassword, SCRYPT_CURRENT, setCurrentScryptParamsForTests, ScryptParams, scryptMaxmem,
} from '@shared/auth/password'
import { LOGIN_REFUSAL_FLOOR_MS } from '@modules/auth/auth.service'

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : def
}
const SAMPLES = arg('--amostras', 30)
const PARALLEL = arg('--paralelo', 20)
const ONLY_CURRENT = process.argv.includes('--so-vigente')

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}
const ms = (x: number) => `${x.toFixed(0)} ms`
const mib = (x: number) => `${(x / 1024 / 1024).toFixed(0)} MiB`

async function measure(params: ScryptParams): Promise<Record<string, string | number>> {
  // grava com o peso medido (o setter é só de teste/medição — nada vai a banco) e confere com a senha ERRADA: o caminho do palpite
  setCurrentScryptParamsForTests(params)
  const stored = await hashPassword('medicao-kq7#mv2x')
  await checkPassword('aquecimento', stored)

  const serial: number[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now()
    await checkPassword(`errada-${i}`, stored)
    serial.push(performance.now() - t)
  }

  let peak = process.memoryUsage().rss
  const base = peak
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
  const t0 = performance.now()
  const parallel = await Promise.all(Array.from({ length: PARALLEL }, async (_, i) => {
    const t = performance.now()
    await checkPassword(`errada-p${i}`, stored)
    return performance.now() - t
  }))
  const wall = performance.now() - t0
  clearInterval(sampler)

  const perSecond = PARALLEL / (wall / 1000)
  return {
    peso: `N=${params.N},r=${params.r},p=${params.p}`,
    'memória por cálculo (128·N·r)': mib(128 * params.N * params.r),
    'teto maxmem': mib(scryptMaxmem(params)),
    'sozinho p50': ms(pct(serial, 50)), 'sozinho p95': ms(pct(serial, 95)), 'sozinho p99': ms(pct(serial, 99)),
    [`${PARALLEL} juntos p50`]: ms(pct(parallel, 50)), [`${PARALLEL} juntos p95`]: ms(pct(parallel, 95)),
    [`${PARALLEL} juntos p99`]: ms(pct(parallel, 99)), [`${PARALLEL} juntos (relógio total)`]: ms(wall),
    'pico de memória (RSS) no paralelo': `${mib(peak)} (+${mib(peak - base)})`,
    'capacidade (verificações/s)': perSecond.toFixed(1),
    '300 req/min por IP (5/s) cabe?': perSecond >= 5 ? 'sim' : `NÃO — ${(5 / perSecond).toFixed(1)}× acima da capacidade`,
    'piso atual das recusas (D-EA43)': ms(LOGIN_REFUSAL_FLOOR_MS),
    'piso acima do p99 sozinho?': LOGIN_REFUSAL_FLOOR_MS > pct(serial, 99) ? 'sim' : 'NÃO',
  }
}

async function main() {
  console.log(`Máquina: ${os.cpus()[0]?.model ?? '?'} · ${os.cpus().length} núcleos · Node ${process.version} · UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '4 (padrão)'}`)
  console.log(`Amostras sozinho: ${SAMPLES} · paralelo: ${PARALLEL}\n`)
  const weights: ScryptParams[] = ONLY_CURRENT
    ? [SCRYPT_CURRENT]
    : [SCRYPT_CURRENT, { N: 2 ** 15, r: 8, p: 2 }, { N: 2 ** 15, r: 8, p: 1 }, { N: 2 ** 14, r: 8, p: 1 }]
  for (const w of weights) {
    const r = await measure(w)
    console.log(`${w === SCRYPT_CURRENT ? '▶ VIGENTE ' : '  compara '}${r.peso}`)
    for (const [k, v] of Object.entries(r)) if (k !== 'peso') console.log(`    ${k.padEnd(36)} ${v}`)
    console.log('')
  }
}

main().catch(err => { console.error(err); process.exitCode = 1 })
