/// <reference types="jest" />
// Q-TZ7 (Valdo 2026-09-30): a pasta do arquivo fiscal é o MÊS CONTÁBIL na zona do
// ESTABELECIMENTO (o mesmo do dCompet) — nota autorizada às 23:30 de 30/09 no Acre
// é de SETEMBRO, mesmo que em Brasília já seja 01/10.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { saveFiscalXml, findFiscalXml } from '../shared/invoice-transmission/branches/service'

const CNPJ = '12345678000199'
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-'))
  process.env.STORAGE_PATH = root
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.STORAGE_PATH
})

const acre2330 = new Date('2026-10-01T04:30:00Z')   // 30/09 23:30 no Acre · 01/10 01:30 em Brasília

it('grava no mês da zona do estabelecimento', () => {
  const full = saveFiscalXml(CNPJ, 'a-nfse.xml', '<x/>', acre2330, 'P', 'America/Rio_Branco')
  expect(path.relative(root, full).split(path.sep)).toEqual([CNPJ, '2026', '09', 'a-nfse.xml'])
})

it('sem zona = hora oficial de Brasília (compatível com o arquivo de antes)', () => {
  const full = saveFiscalXml(CNPJ, 'b-nfse.xml', '<x/>', acre2330, 'P')
  expect(path.relative(root, full).split(path.sep)).toEqual([CNPJ, '2026', '10', 'b-nfse.xml'])
})

it('procura pelo mês da zona e, na virada, pelo da hora oficial', () => {
  saveFiscalXml(CNPJ, 'old-nfse.xml', '<x/>', acre2330, 'P')                     // arquivo antigo (Brasília → 10)
  saveFiscalXml(CNPJ, 'new-nfse.xml', '<x/>', acre2330, 'P', 'America/Rio_Branco') // novo (zona → 09)
  const hint = ['2026-10-01 04:30:00']
  expect(findFiscalXml(CNPJ, 'new-nfse.xml', hint, 'P', 'America/Rio_Branco')).toContain(path.join('2026', '09'))
  expect(findFiscalXml(CNPJ, 'old-nfse.xml', hint, 'P', 'America/Rio_Branco')).toContain(path.join('2026', '10'))
})
