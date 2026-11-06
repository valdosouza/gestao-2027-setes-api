/// <reference types="jest" />
// CERCA da D-F228 (Valdo 2026-11-06, "Cada um no seu" — `prompt_apis_fiscais_isoladas.md` §23): o núcleo `fiscal-api` entra neste
// repositório SÓ pelo pacote versionado em `vendor/` (D-F221…D-F225), instalado em `node_modules/fiscal-api`. Nenhum arquivo de `src` ou
// `scripts` monta caminho para a PASTA IRMÃ do núcleo (`<workspace>/fiscal-api/src|dist|node_modules`): quando o núcleo anda e o `vendor/`
// não, quem lê a irmã prova OUTRO artefato. O fonte do núcleo é conferido pela suíte DELE (que roda na tag); aqui, o que é de EXECUÇÃO
// lê o pacote instalado — `path.dirname(require.resolve('fiscal-api/package.json'))` e, para o `mysql2` do pool,
// `require.resolve('mysql2/promise', { paths: [<pasta do pacote instalado>] })`.
//
// Pelo AST do TypeScript (só os TEXTOS do código — comentário nunca dispara). Violação:
//  (a) o texto `fiscal-api` (ou `fiscal-api/src|dist|node_modules…`) como argumento de uma chamada DEPOIS do 1º — `path.join(W, 'fiscal-api', …)`,
//      `path.resolve(REPO, '..', 'fiscal-api')`, `findSiblingRepo(ROOT, 'fiscal-api', …)`, `path.join(REPO, 'node_modules', 'fiscal-api', …)`
//      (o pacote instalado se acha por `require.resolve`, nunca montando o caminho);
//  (b) `fiscal-api` como 1º argumento seguido de `src`/`dist`/`node_modules` — `path.join('fiscal-api', 'src')`;
//  (c) um texto com `..` + separador + `fiscal-api` (`'../fiscal-api'`, `` `${x}/../../fiscal-api/dist` ``) ou começando por separador +
//      `fiscal-api` (`W + '/fiscal-api'`);
//  (d) a variável `FISCAL_API_DIR` (apontar a irmã por ambiente).
// O import do pacote (`'fiscal-api'`, `'fiscal-api/access'`), `jest.mock('fiscal-api', …)`, `require.resolve('fiscal-api/package.json')` e
// `pkg.dependencies['fiscal-api']` NÃO são violação. Esta cerca exclui a si mesma (as amostras abaixo são violações de propósito).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const SELF = path.resolve(__filename)
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

const walk = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === 'node_modules' || d.name === 'dist' ? [] : walk(path.join(dir, d.name)))
    : CODE_EXT.test(d.name) ? [path.join(dir, d.name)] : []))

const CORE = 'fiscal-api'
const SEGMENT = /^fiscal-api(?:[\\/](?:src|dist|node_modules)(?:[\\/]|$)|$)/
const UP_TO_CORE = /(?:^|[\\/])\.\.[\\/]+(?:[^\\/'"`]+[\\/]+)*fiscal-api(?:[\\/]|$)/
const ROOTED_CORE = /^[\\/]fiscal-api(?:[\\/]|$)/

const textOf = (n: ts.Node): string | null =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text
    : ts.isTemplateExpression(n) ? [n.head.text, ...n.templateSpans.map(s => s.literal.text)].join('${}')
      : null

/** Os pontos de um texto-fonte que montam caminho para a pasta irmã do núcleo (vazio = limpo). */
export function siblingCoreUses(code: string, fileName = 'x.ts'): string[] {
  const kind = /\.(?:m|c)?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind)
  const out: string[] = []
  const at = (n: ts.Node) => `${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${n.getText(sf).slice(0, 100)}`
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const args = n.arguments.map(a => textOf(a))
      args.forEach((t, i) => {
        if (t === null) return
        if (i >= 1 && SEGMENT.test(t)) out.push(at(n))                                              // (a)
        else if (i === 0 && t === CORE && args[1] !== undefined && args[1] !== null && /^(?:src|dist|node_modules)$/.test(args[1])) out.push(at(n))   // (b)
      })
    }
    const t = textOf(n)
    if (t !== null && (UP_TO_CORE.test(t) || ROOTED_CORE.test(t))) out.push(at(n))                     // (c)
    if ((ts.isIdentifier(n) && n.text === 'FISCAL_API_DIR') || (t !== null && t === 'FISCAL_API_DIR')) out.push(at(n))   // (d)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return [...new Set(out)]
}

describe('D-F228 — nenhum caminho para a pasta irmã do núcleo (só o pacote instalado)', () => {
  it('a cerca não é cega: pega cada forma de montar o caminho da irmã', () => {
    for (const bad of [
      "const CORE = path.join(WORKSPACE, 'fiscal-api')",
      "const f = path.join(W, 'fiscal-api', 'src', 'voice', 'kinds.ts')",
      "const CORE = path.resolve(REPO, '..', 'fiscal-api')",
      "const m = require(path.join(__dirname, '..', '..', '..', 'fiscal-api', 'node_modules', 'mysql2', 'promise'))",
      "const CORE = findSiblingRepo(ROOT, 'fiscal-api', 'src/erp/facts.ts')",
      "const d = path.join(REPO, 'node_modules', 'fiscal-api', 'dist')",
      "const d = path.join('fiscal-api', 'src')",
      "const d = path.join(W, 'fiscal-api/src')",
      "const d = '../fiscal-api/src/voice'",
      "const d = `${root}/../../fiscal-api/dist`",
      "const d = WORKSPACE + '/fiscal-api'",
      "const d = process.env.FISCAL_API_DIR",
      "const env = { 'fiscal-api': 'FISCAL_API_DIR' }",
    ]) expect([bad, siblingCoreUses(bad).length > 0]).toEqual([bad, true])
  })
  it('não dá falso positivo: o pacote pelo nome, comentários e o texto solto', () => {
    for (const ok of [
      "import { erp } from 'fiscal-api'",
      "import { accessVerdict } from 'fiscal-api/access'",
      "jest.mock('fiscal-api', () => ({ ...jest.requireActual('fiscal-api') }))",
      "const DIR = path.dirname(require.resolve('fiscal-api/package.json'))",
      "const M2 = require.resolve('mysql2/promise', { paths: [path.dirname(require.resolve('fiscal-api/package.json'))] })",
      "const spec = String(pkg.dependencies?.['fiscal-api'])",
      "const e = lock.packages?.['node_modules/fiscal-api']",
      "// antes: path.join(WORKSPACE, 'fiscal-api', 'src') — e ../fiscal-api/dist\nconst x = 1",
      "/* findSiblingRepo(ROOT, 'fiscal-api', 'src/erp/facts.ts') */ const y = 2",
      "expect(() => fiscalDbName({ FISCAL_DB_NAME: 'fiscal-api' })).toThrow()",
      "if (!code.includes('fiscal-api')) continue",
    ]) expect([ok, siblingCoreUses(ok)]).toEqual([ok, []])
  })
  it('o código REAL deste repositório (src + scripts, sem node_modules/dist; esta cerca fora) não lê a pasta irmã do núcleo', () => {
    const files = [...walk(path.join(PROJECT_ROOT, 'src')), ...walk(path.join(PROJECT_ROOT, 'scripts'))].filter(f => path.resolve(f) !== SELF)
    expect(files.length).toBeGreaterThan(10)
    const hits = files.flatMap(f => siblingCoreUses(fs.readFileSync(f, 'utf8'), f)
      .map(h => `${path.relative(PROJECT_ROOT, f).replace(/\\/g, '/')}:${h}`))
    expect(hits).toEqual([])
  })
})
