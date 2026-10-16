// PREDICADO da cerca da inscrição federal (D-CJ12 — frente do CNPJ alfanumérico). Arquivo GÊMEO, IDÊNTICO byte a byte em
// fiscal-api e nfse-api (`src/__tests__/federal-id-fence.ts`) e no setes-api (`src/test-setup/federal-id-fence.ts` — o jest de lá trata
// qualquer .ts de __tests__ como suíte); o teste adversarial da onda 0 confere a igualdade. Usado pela cerca (`federal-id-fence.test.ts`)
// e pelas sondas dos gates. Por AST (comentário não conta), alarma:
//  (1) regex — literal, ou construída por `RegExp`/`new RegExp` com texto fixo (inclusive guardado numa constante do arquivo) — que NEGA
//      dígito: `\D`, `\P{N…}` ou classe negada com 0-9 / \d / 0123456789 / \x30-\x39 / \p{N…};
//  (2) regex que é UM dígito só (`\d`, `[0-9]`, `\p{Nd}`, com ou sem + e *), em qualquer flag — coleta (`match(…g)`) ou filtra (`.test(c)`);
//  (3) regex que só casa LETRAS (`[A-Z]`…, `\p{L…}`) seguida de '' — tira as letras: o CNPJ alfanumérico vira outro número;
//  (4) comparação com o texto '0' ou '9' (filtro por caractere) e o texto '0123456789' em qualquer lugar (includes/indexOf/contains);
//  (5) D-CJ15 (a cerca vigia o VALOR): helper de dígitos (nome com digit/numeros/onlyNum, alias dele, por namespace, `.call`/`.apply`,
//      entre parênteses) ou coerção numérica (`Number`/`parseInt`/`parseFloat`/`isNaN`) aplicada a um valor que É inscrição federal —
//      pelo texto (cnpj/cpf/inscri/insc/document/federal/doc/ni/id14) ou RASTREADO no arquivo (variável inicializada com ela, desestruturação
//      renomeada, parâmetro de callback sobre ela).
// Gates da onda 0 e da onda 1 (2026-10-15/16, LOW): cada forma que escapava virou SONDA abaixo. O alarme é o TEXTO da menor
// chamada/construção que contém o achado — a lista branca da cerca é por esse texto, com o MOTIVO.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const NOT_DIGIT = /\\D|\\P\{N|\[\^[^\]]*(?:0-9|\\d|0123456789|\\x3[0-9]|\\u003[0-9]|\\p\{N)[^\]]*\]/
const DIGITS_ONLY = /^(?:\\d|\[0-9\]|\\p\{Nd?\}|\[\\x30-\\x39\])[+*]?$/
const LETTERS_ONLY = /^(?:\[(?:A-Z|a-z|A-Za-z|a-zA-Z)\]|\\p\{L[a-z]?\})[+*]?$/
const HELPER_NAME = /digit|numeros|onlynum|sonum/i
const NUMERIC_COERCE: ReadonlySet<string> = new Set(['Number', 'parseInt', 'parseFloat', 'isNaN'])
// `doc`/`ni` só como CAMPO (`t.doc`, `toma.ni`): nu, `doc` é o documento XML da família (falso positivo provado na 1ª versão)
const INSCRIPTION_TEXT = /cnpj|cpf|inscri|\binsc\b|document|federal|\.doc\b|\.ni\b|id14/i
const ITERATORS: ReadonlySet<string> = new Set(['map', 'filter', 'forEach', 'reduce', 'some', 'every', 'flatMap', 'find'])

interface RegexParts { body: string; flags: string }

const stringOf = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null

const isEmptyString = (n: ts.Node | undefined): boolean => stringOf(n) === ''

/** O texto (espaços colapsados) da menor chamada/construção que contém [n] — ou o próprio nó. */
function alarmText(n: ts.Node): string {
  let cur: ts.Node | undefined = n
  while (cur && !ts.isCallExpression(cur) && !ts.isNewExpression(cur)) cur = cur.parent
  return (cur ?? n).getText().split(/\s+/).join(' ')
}

const unwrap = (n: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n)

/** Os alarmes de um código-fonte (um por chamada/construção, na ordem do texto). */
export function strippingHitsIn(code: string): string[] {
  const sf = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const add = (n: ts.Node) => { const t = alarmText(n); if (!hits.includes(t)) hits.push(t) }

  // pré-passe: o que o arquivo amarra a nomes — constantes de texto, apelidos de helper, valores que SÃO inscrição (rastreio simples)
  const strings = new Map<string, string>()
  const helpers = new Set<string>()
  // o rastreio vale no ESCOPO da função onde o nome nasce (e nas internas) — nunca no arquivo inteiro (nome curto de outra função ≠ o mesmo valor)
  const tainted = new Map<ts.Node, Set<string>>()
  const scopeOf = (n: ts.Node): ts.Node => {
    let cur: ts.Node | undefined = n.parent
    while (cur && !ts.isSourceFile(cur) && !ts.isFunctionLike(cur)) cur = cur.parent
    return cur ?? sf
  }
  const taint = (scope: ts.Node, name: string) => { const s = tainted.get(scope) ?? new Set<string>(); s.add(name); tainted.set(scope, s) }
  const isTainted = (id: ts.Identifier): boolean => {
    for (let cur: ts.Node | undefined = id; cur; cur = cur.parent) {
      if ((ts.isSourceFile(cur) || ts.isFunctionLike(cur)) && tainted.get(cur)?.has(id.text)) return true
    }
    return false
  }
  const mentionsInscription = (n: ts.Node): boolean => {
    if (INSCRIPTION_TEXT.test(n.getText())) return true
    let found = false
    const look = (m: ts.Node): void => { if (!found && ts.isIdentifier(m) && isTainted(m)) found = true; else ts.forEachChild(m, look) }
    look(n)
    return found
  }
  const bind = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = unwrap(n.initializer)
      if (ts.isIdentifier(n.name)) {
        const s = stringOf(init)
        if (s !== null) strings.set(n.name.text, s)
        const fnName = ts.isIdentifier(init) ? init.text : ts.isPropertyAccessExpression(init) ? init.name.text : null
        if (fnName && (HELPER_NAME.test(fnName) || helpers.has(fnName))) helpers.add(n.name.text)
        else if (mentionsInscription(init)) taint(scopeOf(n), n.name.text)
      } else if (ts.isObjectBindingPattern(n.name)) {
        const whole = mentionsInscription(init)
        for (const el of n.name.elements) {
          const key = (el.propertyName ?? el.name).getText()
          if (ts.isIdentifier(el.name) && (whole || INSCRIPTION_TEXT.test(key))) taint(scopeOf(n), el.name.text)
        }
      }
    }
    // parâmetro de callback de um iterador chamado SOBRE uma inscrição: `[...cnpj].filter(c => …)` — vale DENTRO do callback
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ITERATORS.has(n.expression.name.text)
      && mentionsInscription(n.expression.expression)) {
      for (const a of n.arguments) {
        if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters[0] && ts.isIdentifier(a.parameters[0].name)) {
          taint(a, a.parameters[0].name.text)
        }
      }
    }
    ts.forEachChild(n, bind)
  }
  bind(sf); bind(sf)                                                     // 2 passes: cadeias curtas (x = p.cnpj; y = x)

  const regexOf = (n: ts.Node): RegexParts | null => {
    if (ts.isRegularExpressionLiteral(n)) {
      const i = n.text.lastIndexOf('/')
      return { body: n.text.slice(1, i), flags: n.text.slice(i + 1) }
    }
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === 'RegExp' && n.arguments?.[0]) {
      const a = n.arguments[0], f = n.arguments[1]
      const body = stringOf(a) ?? (ts.isIdentifier(a) ? strings.get(a.text) ?? null : null)
      if (body !== null) return { body, flags: stringOf(f) ?? '' }
    }
    return null
  }

  /** O nome da função chamada e o índice do 1º argumento "de verdade" (`.call`/`.apply` deslocam 1). */
  const calleeOf = (n: ts.CallExpression): { name: string; first: number } | null => {
    const c = unwrap(n.expression)
    if (ts.isIdentifier(c)) return { name: c.text, first: 0 }
    if (ts.isPropertyAccessExpression(c)) {
      if (c.name.text === 'call' || c.name.text === 'apply') {
        const inner = unwrap(c.expression)
        const name = ts.isIdentifier(inner) ? inner.text : ts.isPropertyAccessExpression(inner) ? inner.name.text : null
        return name ? { name, first: 1 } : null
      }
      return { name: c.name.text, first: 0 }
    }
    if (ts.isElementAccessExpression(c)) {
      const s = stringOf(c.argumentExpression)
      return s ? { name: s, first: 0 } : null
    }
    return null
  }

  const visit = (n: ts.Node): void => {
    const re = regexOf(n)
    if (re) {
      if (NOT_DIGIT.test(re.body)) add(n)
      else if (DIGITS_ONLY.test(re.body)) add(n)
      else if (LETTERS_ONLY.test(re.body) && ts.isRegularExpressionLiteral(n) && n.parent && ts.isCallExpression(n.parent)) {
        const args = n.parent.arguments, i = args.indexOf(n as ts.Expression)
        if (i >= 0 && isEmptyString(args[i + 1])) add(n)
      }
    }
    const s = stringOf(n)
    if (s !== null && s.includes('0123456789')) add(n)
    if (ts.isCallExpression(n)) {
      const callee = calleeOf(n)
      const arg = callee ? n.arguments[callee.first] : undefined
      if (callee && arg && (HELPER_NAME.test(callee.name) || helpers.has(callee.name) || NUMERIC_COERCE.has(callee.name))
        && mentionsInscription(arg)) add(n)
    }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken].includes(n.operatorToken.kind)
      && [n.left, n.right].some(x => ts.isStringLiteral(x) && (x.text === '0' || x.text === '9'))) add(n)
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

/** Sondas da cerca — as formas que escaparam de cada versão anterior (gates das ondas 0 e 1): TODAS têm de alarmar. */
export const FENCE_PROBES_CAUGHT: readonly string[] = [
  // gate da onda 0
  String.raw`x.replace(/\D/g, '')`, String.raw`x.replaceAll(/[^0-9]/g, '')`, String.raw`x.replace(/[^\d]+/g, '')`,
  String.raw`cnpj.split(/\D/).join('')`, String.raw`cnpj.replace(new RegExp('\\D', 'g'), '')`, String.raw`(cnpj.match(/\d/g) ?? []).join('')`,
  String.raw`cnpj.replace(/[A-Z]/g, '')`, String.raw`cnpj.replace(/[^0-9.]/g, '')`, String.raw`cnpj.replace(/[^0123456789]/g, '')`,
  String.raw`cnpj['replace'](/\D/g, '')`, String.raw`String.prototype.replace.call(cnpj, /\D/g, '')`,
  String.raw`[...cnpj].filter(c => c >= '0' && c <= '9').join('')`,
  // regra 5 (onda 1)
  String.raw`el('CNPJ', digits(p.cnpj, 'CNPJ do prestador', 14))`, String.raw`const d = digitsOf(full?.cnpj)`,
  String.raw`stripNonDigits(input.document)`,
  // gate da onda 1 — regra 5 por indireção
  String.raw`const insc = String(inscricao ?? ''); el('CNPJ', digits(insc, 'Id', 14))`,
  String.raw`const x = p.cnpj; el('CNPJ', digits(x, 'CNPJ do prestador', 14))`, String.raw`const { cnpj: c } = p; digits(c, 'x', 14)`,
  String.raw`const d = digits; el('CNPJ', d(p.cnpj, 'x', 14))`, String.raw`(digits)(p.cnpj, 'x', 14)`, String.raw`digits.call(null, p.cnpj, 'x', 14)`,
  String.raw`h.digits(p.cnpj, 'x', 14)`, String.raw`[p.cnpj].map(v => digits(v, 'x', 14))`, String.raw`soNumeros(p.cnpj)`,
  String.raw`digits(t.doc, 'x', 14)`, String.raw`digits(toma.ni, 'x', 14)`, String.raw`digits(emitter.id14, 'x', 14)`,
  // gate da onda 1 — regras 1–4 por outra escrita
  String.raw`cnpj.replace(/[^\x30-\x39]/g, '')`, String.raw`cnpj.replace(/\p{L}/gu, '')`, String.raw`cnpj.replace(/[^\p{Nd}]/gu, '')`,
  String.raw`[...cnpj].filter(c => /\d/.test(c)).join('')`, String.raw`[...cnpj].filter(c => '0123456789'.includes(c)).join('')`,
  String.raw`[...cnpj].filter(c => !isNaN(Number(c))).join('')`, String.raw`const re = '\\D'; cnpj.replace(new RegExp(re, 'g'), '')`,
  String.raw`String(parseInt(cnpj, 10)).padStart(14, '0')`,
]
/** E o que NÃO é mutilação não alarma (a máscara da peça, subir minúscula, conferir a forma, helper sobre CEP/IBGE). */
export const FENCE_PROBES_CLEAN: readonly string[] = [
  String.raw`x.replace(/[./\- ]/g, '')`, String.raw`x.replace(/[a-z]/g, c => c.toUpperCase())`, String.raw`/^[0-9A-Z]{12}[0-9]{2}$/.test(x)`,
  String.raw`el('CEP', digits(t.end.cep, 'CEP do tomador', 8))`, String.raw`digitsOf(rows[0]?.ibge)`, String.raw`/^\d{3}$/.test(code)`,
  String.raw`const n = Number(row.total); parseInt(serie, 10)`,
]
