/// <reference types="jest" />
// D-PV9/D-PV41/D-PV51 — o triângulo código → lista → registro fecha também no JEST, contra o banco do dev (gate socrático 2026-10-18: só
// o boot conferia, e em produção, no próximo restart). A cerca prova código ⊂ conjunto operado (lista à mão ∪ tabela do roteador —
// D-PV14); este teste prova a IGUALDADE por interface (D-PV51): registro vivo e ativo = operados ∪ VISUALIZAR em toda tela ∪ CONFIGURAR
// em toda interface com config/campo (+ general-configs) ∪ reservados — par faltando E par sobrando reprovam. Obrigatório na suíte
// (D-PV41): vermelho = o seed não foi ao banco ANTES do código. SOMENTE LEITURA: sessão READ ONLY, só SELECT no setes_central (o mesmo
// `readPrivilegeCatalogProblems` do boot e do `scripts/check-privilege-catalog.ts`).
import pool from '@shared/db/connection'
import router from '../gateway/router'
import { listGatedModules } from '@shared/auth/module-privilege-gate'
import { readPrivilegeCatalogProblems, privilegeCatalogAlarms } from '@shared/auth/assert-privilege-catalog'

void router                                                     // montar o gateway registra as guardas (a tabela da D-PV14)

pool.on('connection', conn => {
  const raw = conn as unknown as { query: (sql: string, cb: (err: unknown) => void) => void }
  raw.query('SET SESSION TRANSACTION READ ONLY', () => undefined)
})

afterAll(async () => { await pool.end() })

describe('D-PV9/D-PV51 — o registro vivo do dev é IGUAL ao que o código opera, por interface (só leitura)', () => {
  it('a sessão desta conferência é READ ONLY', async () => {
    const [rows] = await pool.query<any[]>('SELECT @@session.tx_read_only AS ro')
    expect(Number(rows[0].ro)).toBe(1)
  })

  it('a tabela da guarda por roteador está montada (sem ela os pares do CRUD não seriam conferidos)', () => {
    expect(listGatedModules().length).toBeGreaterThan(0)
  })

  it('nenhum alarme: nada faltando nem SOBRANDO, nomes certos, toda tela com VISUALIZAR, CONFIGURAR onde a regra pede, chaves sem ambiguidade', async () => {
    expect(privilegeCatalogAlarms(await readPrivilegeCatalogProblems())).toEqual([])
  })
})
