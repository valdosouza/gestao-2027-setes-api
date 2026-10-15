/// <reference types="jest" />
// Fase IBS/CBS, IB-2 (D-IB71 — prompt_fase_ibs_cbs.md §12.6): CERCA — a declaração IBS/CBS congelada no ramo
// (`tb_invoice_service.classification_code`, `place_indicator_code`, `nbs`) tem UM escritor: a peça @shared/invoice
// (`issueInvoice`), que a recebe pronta da composição @shared/service-ibscbs-declaration. Qualquer outro comando que ESCREVA
// essas colunas é um 2º congelador (maquete nº 1 do §12.3) — este teste falha e diz onde.
// ADV-IB2-02 (gate adversarial da IB-2, LOW): a 1ª versão só via `INSERT INTO`/`UPDATE` colados no nome da tabela; agora a
// unidade é a CHAMADA `.query(…)` inteira (SQL + parâmetros) — pega `INSERT IGNORE`, `REPLACE`, `UPDATE … JOIN … SET sv.nbs`
// e o identificador por `??` — e a varredura cobre src/, scripts/ e as migrations .sql. Limite conhecido: tabela por VARIÁVEL
// (`${table}`) não é vista (hoje só o soft-delete do cancelamento usa essa forma, sem as colunas).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { splitStatements } from '../migrations/runner'

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const SCRIPTS = path.join(ROOT, 'scripts')
const MIGRATIONS = path.join(SRC, 'migrations', 'sql')
const WRITER = path.join(SRC, 'shared', 'invoice', 'invoice.ts')
/** Provas que escrevem SÓ no schema DESCARTÁVEL que criam e apagam (nunca num schema real) — exceção nomeada. */
const DISPOSABLE_PROOFS = new Set([path.join(SCRIPTS, 'prove-ibscbs-declaration-checks.ts')])
const TABLE = /tb_invoice_service(?![_a-z0-9])/
const WRITE = /\b(INSERT|REPLACE|UPDATE)\b/i
const COLUMNS = /\b(classification_code|place_indicator_code|nbs)\b/

function tsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : tsFiles(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}

/** Chamadas `.query(…)` (SQL + parâmetros, até a próxima chamada) que ESCREVEM as colunas da declaração em tb_invoice_service. */
function writesOfDeclaration(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const found: string[] = []
  const call = /\.query(?:<[^>]*>)?\s*\(/g
  for (let m = call.exec(text); m; m = call.exec(text)) {
    const next = text.indexOf('.query', m.index + 6)
    const window = text.slice(m.index, Math.min(next < 0 ? text.length : next, m.index + 3000))
    if (TABLE.test(window) && WRITE.test(window) && COLUMNS.test(window)) {
      found.push(window.slice(0, 90).replace(/\s+/g, ' '))
    }
  }
  return found
}

/** Comandos de migration (.sql, sem comentários) que ESCREVEM as colunas da declaração em tb_invoice_service. */
function sqlWritesOfDeclaration(file: string): string[] {
  return splitStatements(fs.readFileSync(file, 'utf8'))
    .filter(st => /^\s*(INSERT|REPLACE|UPDATE)\b/i.test(st) && TABLE.test(st) && COLUMNS.test(st))
    .map(st => st.slice(0, 90).replace(/\s+/g, ' '))
}

describe('cerca da declaração IBS/CBS no ramo (D-IB71 + ADV-IB2-02)', () => {
  it('o escritor ÚNICO existe (a cerca não é vazia): @shared/invoice grava as 3 colunas', () => {
    expect(writesOfDeclaration(WRITER).length).toBeGreaterThan(0)
  })

  it('o detector pega as formas que escapavam (INSERT IGNORE, REPLACE, UPDATE … JOIN, ??) e ignora leitura e a peça 1:1 do serviço', () => {
    const tmp = path.join(os.tmpdir(), `fence-ib2-${process.pid}.ts`)
    const bt = '`'
    fs.writeFileSync(tmp, [
      `await conn.query(${bt}UPDATE \\${bt}\${s}\\${bt}.tb_invoice_service SET nbs = ? WHERE id = ?${bt}, [n, id])`,
      `await conn.query(${bt}INSERT IGNORE INTO \\${bt}\${s}\\${bt}.tb_invoice_service (id, classification_code) VALUES (?, ?)${bt}, [id, c])`,
      `await conn.query(${bt}REPLACE INTO \\${bt}\${s}\\${bt}.tb_invoice_service (id, nbs) VALUES (?, ?)${bt}, [id, n])`,
      `await conn.query(${bt}UPDATE \\${bt}\${s}\\${bt}.tb_invoice i JOIN \\${bt}\${s}\\${bt}.tb_invoice_service sv ON sv.id = i.id SET sv.place_indicator_code = ?${bt}, [p])`,
      `await db.query(${bt}INSERT INTO ?? (id, classification_code) VALUES (?, ?)${bt}, [${bt}\${s}.tb_invoice_service${bt}, id, c])`,
      `await conn.query(${bt}SELECT nbs FROM \\${bt}\${s}\\${bt}.tb_invoice_service WHERE id = ?${bt}, [id])`,
      `await conn.query(${bt}INSERT INTO \\${bt}\${s}\\${bt}.tb_service_ibscbs (id, classification_code) VALUES (?, ?)${bt}, [id, c])`,
    ].join('\n'))
    try {
      expect(writesOfDeclaration(tmp)).toHaveLength(5)
    } finally { fs.unlinkSync(tmp) }
  })

  it('nenhum outro arquivo de src/ ou scripts/ grava classification_code / place_indicator_code / nbs em tb_invoice_service', () => {
    const offenders = [...tsFiles(SRC), ...tsFiles(SCRIPTS)]
      .filter(f => f !== WRITER && !DISPOSABLE_PROOFS.has(f))
      .flatMap(f => writesOfDeclaration(f).map(w => `${path.relative(ROOT, f)}: ${w}`))
    expect(offenders).toEqual([])
  })

  it('nenhuma migration .sql ESCREVE essas colunas (as que as criam/protegem — 066, 070 — são DDL)', () => {
    const offenders = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))
      .flatMap(f => sqlWritesOfDeclaration(path.join(MIGRATIONS, f)).map(w => `${f}: ${w}`))
    expect(offenders).toEqual([])
  })
})
