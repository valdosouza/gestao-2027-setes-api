/// <reference types="jest" />
// CERCA da regra de tempo (PADROES_BANCO §10, Q-TZ1; L5 do gate socrático da onda TZ-1):
// data de NEGÓCIO nunca vem do relógio da sessão/processo. Este teste varre src/ e
// falha se um padrão proibido voltar — a regra não depende de memória de quem codifica.
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set(['__tests__', 'migrations', 'test-setup'])
const SKIP_FILES = new Set([path.join('shared', 'time-zone', 'index.ts')])   // a peça documenta os proibidos

const FORBIDDEN: [RegExp, string][] = [
  [/\bCURDATE\s*\(/i, 'CURDATE() — use todayFor(schema, institution, conn) como parâmetro'],
  [/\bCURRENT_DATE\b/i, 'CURRENT_DATE — use todayFor'],
  [/\bDATE\s*\(\s*NOW\s*\(\s*\)\s*\)/i, 'DATE(NOW()) — use todayFor'],
  [/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/, 'new Date().toISOString().slice(0, 10) é o dia UTC — use todayFor/todayIn'],
  [/\.getTimezoneOffset\(\)/, 'getTimezoneOffset() é o fuso do PROCESSO — use @shared/time-zone'],
]

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out) }
    else if (e.name.endsWith('.ts')) out.push(path.join(dir, e.name))
  }
  return out
}

it('nenhum padrão proibido de "hoje"/fuso do processo em src/ (fora a peça de fuso)', () => {
  const hits: string[] = []
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file)
    if (SKIP_FILES.has(rel)) continue
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '')            // comentário de linha não conta
      if (/^\s*\*/.test(code)) return                       // nem linha de bloco de comentário
      for (const [re, why] of FORBIDDEN) if (re.test(code)) hits.push(`${rel}:${i + 1} ${why}`)
    })
  }
  expect(hits).toEqual([])
})
