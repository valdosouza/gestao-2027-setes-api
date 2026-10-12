/// <reference types="jest" />
// CERCAS da F2a, etapa A3 (`prompt_apis_fiscais_isoladas.md` §22.5 item 8 + D-F4/D-F11/D-F15/D-NE77/nota (8)): o setes-api é PASSIVO.
//  (a) zero conversa com as APIs fiscais ou com o fisco (nenhuma URL/porta delas, nenhum adaptador);
//  (b) o `fiscal_api` só é lido pela PORTA `src/shared/fiscal-voice/` (e só pelo leitor do núcleo — `fiscal-api/reading`);
//  (c) nenhuma leitura/escrita das tabelas de transmissão do ERP (origem CONGELADA — D-F110) e a habilitação só como SÉRIE
//      (`@shared/invoice-series`, SELECT);
//  (d) nenhuma decisão por COLUNA CRUA da voz nas composições do ERP (`environment === 'H'|'P'`, `lastQueriedAt`/`last_queried_at`,
//      a chave como CONDIÇÃO, letra exclusiva da voz comparada à mão — F2A3-SOC-08) — registro, prova e efeito vêm dos predicados
//      do núcleo.
// Análise por AST (literais e expressões — comentário não conta). Exceção nomeada = caminho conferido aqui.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === 'node_modules' || d.name === '__tests__' || d.name === 'test-setup' ? [] : walk(path.join(dir, d.name)))
      : /\.ts$/.test(d.name) ? [path.join(dir, d.name)] : [])
}
const FILES = walk(SRC)
const sourceOf = (f: string) => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

/** Todo texto LITERAL do arquivo (strings, template literals e suas partes) — o que chega ao SQL, à URL ou ao log. */
function literals(sf: ts.SourceFile): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text)
    else if (ts.isTemplateExpression(n)) { out.push(n.head.text); for (const sp of n.templateSpans) out.push(sp.literal.text) }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
const inPort = (f: string) => rel(f).startsWith('src/shared/fiscal-voice/')

/** `x.accessKey` / `x?.accessKey` (acesso à chave da voz). */
const isAccessKey = (n: ts.Node): n is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(n) && n.name.text === 'accessKey'
/** Exceção NOMEADA: dentro da peça que lê a chave DEPOIS do fato do registro (`fiscalRecordKey` — registro sem chave falha alto). */
function insideFunction(n: ts.Node, name: string): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p) && p.name?.text === name) return true
  return false
}
/** A expressão decide por VERDADE (condição de if/ternário/while, operando de `!`, `&&`, `||`, `??`) — e não só a lê como valor. */
function usedAsCondition(n: ts.Node): boolean {
  let child: ts.Node = n
  let p: ts.Node = n.parent
  while (ts.isParenthesizedExpression(p)) { child = p; p = p.parent }
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true
  if ((ts.isIfStatement(p) || ts.isWhileStatement(p)) && p.expression === child) return true
  if (ts.isConditionalExpression(p) && p.condition === child) return true
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind
    // `a && x.accessKey` como VALOR final (lado direito) também decide nada; o lado ESQUERDO de && / || / ?? decide
    if ((op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
      && p.left === child) return true
  }
  return false
}

describe('cerca F2a A3 — o setes-api é PASSIVO', () => {
  it('(a) nenhuma URL/porta das APIs fiscais nem do fisco em código (D-F4: o app fala com elas; o setes-api nunca)', () => {
    const bad: string[] = []
    for (const f of FILES) for (const t of literals(sourceOf(f))) {
      if (/\/v1\/(nfse|nfe|emitter)\b|localhost:300[23]\b|nfse-api|nfe-api|sefin\.nfse|adn\.nfse|nfse\.gov\.br/i.test(t)) bad.push(`${rel(f)}: ${t.slice(0, 80)}`)
    }
    expect(bad).toEqual([])
  })
  it('(a) as peças fiscais de conversa com o fisco não existem mais (transmissão, adaptador/transporte/assinatura, DANFSe, emissor, cofre do A1)', () => {
    for (const dir of ['invoice-transmission', 'tax-authority', 'danfse', 'fiscal-issuer']) {
      expect([dir, fs.existsSync(path.join(SRC, 'shared', dir))]).toEqual([dir, false])
    }
    for (const f of ['modules/billing/billing.fiscal.service.ts', 'modules/billing/billing.fiscal.controller.ts',
      'modules/establishment/establishment.issuer.service.ts', 'modules/establishment/establishment.issuer.controller.ts']) {
      expect([f, fs.existsSync(path.join(SRC, f))]).toEqual([f, false])
    }
  })
  it('(b) o banco fiscal_api e as views da voz só aparecem na PORTA src/shared/fiscal-voice/', () => {
    const bad: string[] = []
    for (const f of FILES) {
      if (inPort(f)) continue
      for (const t of literals(sourceOf(f))) {
        if (/\bfiscal_api\b|vw_invoice_service_transmission/.test(t)) bad.push(`${rel(f)}: ${t.slice(0, 80)}`)
      }
    }
    expect(bad).toEqual([])
  })
  it('(b) o leitor da voz do núcleo (readFamilyTransmissions*, assertFamilyViewsReadable) só é chamado pela porta', () => {
    const bad: string[] = []
    for (const f of FILES) {
      if (inPort(f)) continue
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && /^(readFamilyTransmissions|readFamilyTransmissionsMany|assertFamilyViewsReadable)$/.test(n.text)) bad.push(`${rel(f)}: ${n.text}`)
        ts.forEachChild(n, visit)
      }
      visit(sourceOf(f))
    }
    expect(bad).toEqual([])
  })
  it('(c) nenhuma referência às tabelas de transmissão/voz do ERP (origem CONGELADA pela f2a_fiscal_passivo — D-F110)', () => {
    const bad: string[] = []
    for (const f of FILES) for (const t of literals(sourceOf(f))) {
      if (/tb_invoice_service_transmission|tb_invoice_service_dps\b/.test(t)) bad.push(`${rel(f)}: ${t.slice(0, 80)}`)
    }
    expect(bad).toEqual([])
  })
  it('(c) a habilitação (tb_establishment_issuer) só aparece na SÉRIE da nota, e só em SELECT (D-F112)', () => {
    const bad: string[] = []
    for (const f of FILES) for (const t of literals(sourceOf(f))) {
      if (!/tb_establishment_issuer/.test(t)) continue
      // a peça da série: a consulta é um template (`SELECT serie FROM \`${s}\`` + `.tb_establishment_issuer WHERE …`) — só leitura
      if (rel(f) === 'src/shared/invoice-series/invoice-series.ts' && !/\b(INSERT|UPDATE|DELETE|REPLACE|FOR UPDATE)\b/i.test(t)) continue
      bad.push(`${rel(f)}: ${t.slice(0, 80)}`)
    }
    expect(bad).toEqual([])
  })
  it('(d) nenhuma decisão por coluna crua da voz nas composições do ERP (nota (8), §22.5 item 8)', () => {
    const SCOPE = ['src/shared/invoice/', 'src/modules/billing/', 'src/modules/service-orders/', 'src/shared/fiscal-voice/']
    const bad: string[] = []
    for (const f of FILES.filter(x => SCOPE.some(sc => rel(x).startsWith(sc)))) {
      const visit = (n: ts.Node): void => {
        // x.environment === 'H' | 'P' (ou !==) — o ambiente decide pelo isFiscalRecord do núcleo
        if (ts.isBinaryExpression(n) && /^(===|!==|==|!=)$/.test(n.operatorToken.getText())) {
          const sides = [n.left, n.right]
          const env = sides.some(x => ts.isPropertyAccessExpression(x) && x.name.text === 'environment')
          const hp = sides.some(x => ts.isStringLiteral(x) && (x.text === 'H' || x.text === 'P'))
          if (env && hp) bad.push(`${rel(f)}: ${n.getText().slice(0, 80)}`)
        }
        // "nós olhamos" nunca é prova (D-F90)
        if (ts.isPropertyAccessExpression(n) && n.name.text === 'lastQueriedAt') bad.push(`${rel(f)}: ${n.getText().slice(0, 80)}`)
        // a chave nunca é sinal de registro (D-NE56/nota (8)) — nem como CONDIÇÃO (F2A3-SOC-08, gate socrático da A3: `!x.accessKey`,
        // `x?.accessKey ? … : …`, `if (x.accessKey)`, `x.accessKey && …`); a chave é IDENTIDADE, lida depois do fato (`fiscalRecordKey`)
        if (isAccessKey(n) && usedAsCondition(n) && !insideFunction(n, 'fiscalRecordKey')) bad.push(`${rel(f)}: ${n.parent.getText().slice(0, 80)}`)
        // letra EXCLUSIVA da voz comparada à mão (S/A/N/K/R/F) — o estado é o `fiscalStateOf`/predicados do núcleo. 'C'/'E' também são
        // eventos da NOTA (fato do ERP) e ficam de fora desta cerca
        if (ts.isBinaryExpression(n) && /^(===|!==|==|!=)$/.test(n.operatorToken.getText())) {
          const sides = [n.left, n.right]
          const kind = sides.some(x => ts.isPropertyAccessExpression(x) && x.name.text === 'lastKind')
          const voiceOnly = sides.some(x => ts.isStringLiteral(x) && ['S', 'A', 'N', 'K', 'R', 'F'].includes(x.text))
          if (kind && voiceOnly) bad.push(`${rel(f)}: ${n.getText().slice(0, 80)}`)
        }
        ts.forEachChild(n, visit)
      }
      const sf = sourceOf(f)
      visit(sf)
      for (const t of literals(sf)) if (/last_queried_at/.test(t)) bad.push(`${rel(f)}: ${t.slice(0, 80)}`)
    }
    expect(bad).toEqual([])
  })
  it('(d) a cerca da chave como CONDIÇÃO pega as formas do gate (F2A3-SOC-08) e deixa passar a leitura como VALOR', () => {
    const snippet = [
      'if (!tx.accessKey) x()', 'const w = cur?.accessKey ? f(cur.accessKey) : null', 'if (t.accessKey) y()', 'const z = t.accessKey && 1',
      'while ((t.accessKey)) {}', 'const k = t.accessKey ?? "x"',
      'const v = { key: t.accessKey }', 'g(t.accessKey)', 'const s = a && t.accessKey',
      'function fiscalRecordKey(c: any) { if (!c.accessKey) throw 1; return c.accessKey }',
    ].join('\n')
    const sf = ts.createSourceFile('snippet.ts', snippet, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const hits: number[] = []
    const visit = (n: ts.Node): void => {
      if (isAccessKey(n) && usedAsCondition(n) && !insideFunction(n, 'fiscalRecordKey')) hits.push(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(hits).toEqual([1, 2, 3, 4, 5, 6])
  })
  it('a porta só importa a SUPERFÍCIE de leitura do núcleo; o boot confere as views das famílias (D-F113/D-F127)', () => {
    const server = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8')
    expect(server).toMatch(/assertFiscalVoiceReadable\(pool\)/)
  })
})
