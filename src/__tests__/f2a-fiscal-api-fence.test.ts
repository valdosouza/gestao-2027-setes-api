/// <reference types="jest" />
// F2a, etapa A2 (D-NE77 + gate socrático da A2, achado 10 — prompt_apis_fiscais_isoladas.md §22.9): o setes-api depende
// da biblioteca do núcleo (`file:../fiscal-api`), mas só pode importar a SUPERFÍCIE DE LEITURA `fiscal-api/reading`. O
// `exports` do pacote publica também a raiz (o barrel com o lado de ESCRITA — descritor da família, `withInvoiceTx`, emitente,
// A1); a cerca do núcleo (`ne1a-superficie.test.ts`) vigia daqui de fora, esta vigia de DENTRO, na suíte do próprio setes-api.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const ROOTS = ['src', 'scripts'].map(d => path.join(__dirname, '..', '..', d))

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : /\.(?:ts|js)$/.test(d.name) ? [path.join(dir, d.name)] : [])
}

describe('cerca F2a — o setes-api só importa `fiscal-api/reading`', () => {
  it('nenhum import/require/import() de `fiscal-api` (raiz) ou de outro subpath dele', () => {
    const bad: string[] = []
    for (const f of ROOTS.flatMap(walk)) {
      if (f === __filename) continue
      const code = fs.readFileSync(f, 'utf8')
      if (!code.includes('fiscal-api')) continue
      const sf = ts.createSourceFile(f, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const visit = (n: ts.Node): void => {
        const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text
          : ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
            && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : null
        if (spec && /^fiscal-api(?:\/|$)/.test(spec) && spec !== 'fiscal-api/reading') bad.push(`${path.relative(path.join(__dirname, '..', '..'), f)}: ${spec}`)
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    expect(bad).toEqual([])
  })
  it('a dependência existe e aponta para a biblioteca irmã', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))
    expect(pkg.dependencies['fiscal-api']).toBe('file:../fiscal-api')
  })
})
