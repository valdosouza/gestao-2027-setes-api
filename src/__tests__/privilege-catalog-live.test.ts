/// <reference types="jest" />
// D-PV9 — o triângulo código → lista → catálogo fecha também no JEST, contra o banco do dev (gate socrático 2026-10-18: só o boot
// conferia, e em produção, no próximo restart). A cerca prova código ⊂ lista; este teste prova lista ⊂ catálogo vivo — o par novo
// entra no seed e o seed vai ao banco ANTES de o app/rota que o consome ser publicado. SOMENTE LEITURA: sessão READ ONLY, só SELECT
// no setes_central (o mesmo `readPrivilegeCatalogProblems` do boot e do `scripts/check-privilege-catalog.ts`).
import pool from '@shared/db/connection'
import { readPrivilegeCatalogProblems, privilegeCatalogAlarms } from '@shared/auth/assert-privilege-catalog'

pool.on('connection', conn => {
  const raw = conn as unknown as { query: (sql: string, cb: (err: unknown) => void) => void }
  raw.query('SET SESSION TRANSACTION READ ONLY', () => undefined)
})

afterAll(async () => { await pool.end() })

describe('D-PV9 — o catálogo vivo do dev cobre a lista única (só leitura)', () => {
  it('a sessão desta conferência é READ ONLY', async () => {
    const [rows] = await pool.query<any[]>('SELECT @@session.tx_read_only AS ro')
    expect(Number(rows[0].ro)).toBe(1)
  })

  it('nenhum alarme: todo par consumido no catálogo, nomes certos, toda tela do cliente com VISUALIZAR, i18n_key sem ambiguidade', async () => {
    expect(privilegeCatalogAlarms(await readPrivilegeCatalogProblems())).toEqual([])
  })
})
