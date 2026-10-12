/// <reference types="jest" />
// F2a, etapa A3 — D-F110 + D-F50 (errata 2026-10-12): a migration `NNN_f2a_fiscal_passivo` CONGELA a escrita fiscal do ERP por gatilhos de
// trava; o NOME é o fato que a nfse-api confere antes do ato da virada (`_migrations.name`), e ela é o ÚLTIMO arquivo da F2a. A prova no
// banco (descartável) é `scripts/prove-f2a-passivo.ts`; aqui, a forma do arquivo como o runner do BOOT o divide.
import fs from 'fs'
import path from 'path'
import { splitStatements } from '../migrations/runner'

const DIR = path.join(__dirname, '..', 'migrations', 'sql')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const passivo = files.filter(f => /^\d{3}_f2a_fiscal_passivo\.sql$/.test(f))

describe('NNN_f2a_fiscal_passivo (D-F110/D-F50)', () => {
  it('existe UMA vez, com o nome fixo, e é o ÚLTIMO arquivo de migration (o ato da virada confere o NOME)', () => {
    expect(passivo).toHaveLength(1)
    expect(files[files.length - 1]).toBe(passivo[0])
  })
  const statements = passivo.length ? splitStatements(fs.readFileSync(path.join(DIR, passivo[0]), 'utf8')) : []
  it('o runner divide em DROP IF EXISTS + CREATE TRIGGER (re-executável) para os 9 gatilhos de TRAVA, e 4 ALTER de comentário', () => {
    const drops = statements.filter(s => /^DROP TRIGGER IF EXISTS `tg_f2a_freeze_/.test(s))
    const creates = statements.filter(s => /^CREATE TRIGGER `tg_f2a_freeze_\w+` BEFORE (INSERT|UPDATE|DELETE) ON `tb_(invoice_service_transmission(_event)?|establishment_issuer)`/.test(s))
    expect(drops).toHaveLength(9); expect(creates).toHaveLength(9)
    expect(statements.filter(s => /^ALTER TABLE/.test(s))).toHaveLength(4)
    expect(statements).toHaveLength(22)
    for (const c of creates) expect(c).toMatch(/\nBEGIN\n[\s\S]*\nEND$/)             // bloco inteiro num comando só (o runner corta fora do bloco)
  })
  it('todo gatilho recusa com SIGNAL 45000 e mensagem ASCII ≤ 128 que cita a decisão; nenhuma escrita de dado na migration', () => {
    const msgs = statements.flatMap(s => [...s.matchAll(/MESSAGE_TEXT = '([^']*)'/g)].map(m => m[1]))
    expect(msgs.length).toBeGreaterThanOrEqual(9)
    for (const m of msgs) { expect(m.length).toBeLessThanOrEqual(128); expect(m).toMatch(/^F2a \(D-F110/); expect(/^[\x20-\x7e]*$/.test(m)).toBe(true) }
    expect(statements.some(s => /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s))).toBe(false)
    expect(statements.some(s => /\bDROP TABLE\b|\bDROP COLUMN\b/i.test(s))).toBe(false)          // aposentar ≠ apagar (DROP = decisão futura)
  })
  it('a habilitação SE: só o ATO da virada (N→S) passa — o gatilho de UPDATE não barra deleted N→S nem a série', () => {
    const bu = statements.find(s => /tg_f2a_freeze_issuer_se_bu` BEFORE UPDATE/.test(s))!
    expect(bu).toMatch(/OLD\.`deleted` = 'S' AND NEW\.`deleted` <> 'S'/)                 // revive barrado; aposentar não
    expect(bu).toMatch(/NEW\.`environment` <=> OLD\.`environment`/)
    expect(bu).toMatch(/NEW\.`dps_last_number` <=> OLD\.`dps_last_number`/)
    expect(bu).not.toMatch(/serie/)
  })
})
