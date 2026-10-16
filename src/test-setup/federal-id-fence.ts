// PREDICADO da cerca da inscrição federal (D-CJ12 — frente do CNPJ alfanumérico). Arquivo GÊMEO, IDÊNTICO byte a byte em
// fiscal-api e nfse-api (`src/__tests__/federal-id-fence.ts`) e no setes-api (`src/test-setup/federal-id-fence.ts` — o jest de lá trata
// qualquer .ts de __tests__ como suíte); o teste adversarial da onda 0 confere a igualdade. Usado pela cerca (`federal-id-fence.test.ts`)
// e pelas sondas do gate. Gate adversarial da onda 0 (2026-10-15, LOW): a 1ª versão olhava só a regex
// LITERAL com \D dentro de `.replace` — escapavam split(/\D/), new RegExp('\\D'), match(/\d/g).join, replace(/[A-Z]/g,''), [^0-9.],
// [^0123456789], x['replace'](…), String.prototype.replace.call(…) e o filtro por caractere. Agora, por AST (comentário não conta):
//  (1) QUALQUER regex — literal ou construída por `RegExp`/`new RegExp` com texto fixo — que nega dígito: `\D` ou classe negada com
//      0-9 / \d / 0123456789;
//  (2) regex que COLETA dígitos: só `\d`/`[0-9]` (com + ou *) e a flag g;
//  (3) regex que só casa LETRAS seguida de '' (tira as letras: o CNPJ alfanumérico vira outro número);
//  (4) comparação com o texto '0' ou '9' (filtro por caractere).
// O alarme é o TEXTO da menor chamada/construção que contém o achado — a lista branca da cerca é por esse texto, com o MOTIVO.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const NOT_DIGIT = /\\D|\[\^[^\]]*(?:0-9|\\d|0123456789)[^\]]*\]/
const DIGITS_ONLY = /^(?:\\d|\[0-9\])[+*]?$/
const LETTERS_ONLY = /^\[(?:A-Z|a-z|A-Za-z|a-zA-Z)\][+*]?$/

interface RegexParts { body: string; flags: string }

function regexOf(n: ts.Node): RegexParts | null {
  if (ts.isRegularExpressionLiteral(n)) {
    const i = n.text.lastIndexOf('/')
    return { body: n.text.slice(1, i), flags: n.text.slice(i + 1) }
  }
  if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === 'RegExp' && n.arguments?.[0]) {
    const a = n.arguments[0], f = n.arguments[1]
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) {
      return { body: a.text, flags: f && (ts.isStringLiteral(f) || ts.isNoSubstitutionTemplateLiteral(f)) ? f.text : '' }
    }
  }
  return null
}

const isEmptyString = (n: ts.Node | undefined): boolean => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === ''

/** O texto (espaços colapsados) da menor chamada/construção que contém [n] — ou o próprio nó. */
function alarmText(n: ts.Node): string {
  let cur: ts.Node | undefined = n
  while (cur && !ts.isCallExpression(cur) && !ts.isNewExpression(cur)) cur = cur.parent
  return (cur ?? n).getText().split(/\s+/).join(' ')
}

/** Os alarmes de um código-fonte (um por chamada/construção, na ordem do texto). */
export function strippingHitsIn(code: string): string[] {
  const sf = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const add = (n: ts.Node) => { const t = alarmText(n); if (!hits.includes(t)) hits.push(t) }
  const visit = (n: ts.Node): void => {
    const re = regexOf(n)
    if (re) {
      if (NOT_DIGIT.test(re.body)) add(n)
      else if (DIGITS_ONLY.test(re.body) && re.flags.includes('g')) add(n)
      else if (LETTERS_ONLY.test(re.body) && ts.isCallExpression(n.parent) && ts.isRegularExpressionLiteral(n)) {
        const args = n.parent.arguments, i = args.indexOf(n as ts.Expression)
        if (i >= 0 && isEmptyString(args[i + 1])) add(n)
      }
    }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken].includes(n.operatorToken.kind)
      && [n.left, n.right].some(s => ts.isStringLiteral(s) && (s.text === '0' || s.text === '9'))) add(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (['node_modules', '__tests__', 'test-setup', 'dist'].includes(e.name) ? [] : walk(path.join(dir, e.name)))
      : /\.ts$/.test(e.name) ? [path.join(dir, e.name)] : [])
}

/** `arquivo: texto do alarme` de todo `src/` e `scripts/` do repositório (fora `__tests__` e `test-setup`, onde mora este predicado). */
export function repoStrippingHits(root: string): string[] {
  const out: string[] = []
  for (const f of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))]) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    for (const h of strippingHitsIn(fs.readFileSync(f, 'utf8'))) out.push(`${rel}: ${h}`)
  }
  return out
}

/** Sondas da cerca (as 9 formas que escapavam da 1ª versão + as 3 que ela já pegava): TODAS têm de alarmar. */
export const FENCE_PROBES_CAUGHT: readonly string[] = [
  String.raw`x.replace(/\D/g, '')`, String.raw`x.replaceAll(/[^0-9]/g, '')`, String.raw`x.replace(/[^\d]+/g, '')`,
  String.raw`cnpj.split(/\D/).join('')`, String.raw`cnpj.replace(new RegExp('\\D', 'g'), '')`, String.raw`(cnpj.match(/\d/g) ?? []).join('')`,
  String.raw`cnpj.replace(/[A-Z]/g, '')`, String.raw`cnpj.replace(/[^0-9.]/g, '')`, String.raw`cnpj.replace(/[^0123456789]/g, '')`,
  String.raw`cnpj['replace'](/\D/g, '')`, String.raw`String.prototype.replace.call(cnpj, /\D/g, '')`,
  String.raw`[...cnpj].filter(c => c >= '0' && c <= '9').join('')`,
]
/** E o que NÃO é mutilação não alarma (a máscara da peça, subir minúscula, conferir a forma). */
export const FENCE_PROBES_CLEAN: readonly string[] = [
  String.raw`x.replace(/[./\- ]/g, '')`, String.raw`x.replace(/[a-z]/g, c => c.toUpperCase())`, String.raw`/^[0-9A-Z]{12}[0-9]{2}$/.test(x)`,
]
