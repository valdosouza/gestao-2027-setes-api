/**
 * Re-prova dos HIGH 1 e 2 do gate adversarial: concorrência que travava o pool
 * (config lida dentro da transação) e deadlock do MAX+1 sem lock da institution.
 */
import 'dotenv/config'
import jwt from 'jsonwebtoken'
import pool from '@shared/db/connection'

const BASE = 'http://localhost:3000'
const token = jwt.sign(
  { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

async function api(m: string, p: string, b?: unknown) {
  const r = await fetch(`${BASE}/api${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  })
  return { status: r.status, body: await r.json().catch(() => null) as any }
}

async function abreOrdens(n: number): Promise<number[]> {
  const ids: number[] = []
  const [clientes] = await pool.query<any[]>(
    `SELECT id FROM setes_setes.tb_customer WHERE tb_institution_id = 1 AND deleted = 'N'
      ORDER BY id DESC LIMIT ?`, [n])
  const [produto] = await pool.query<any[]>(
    `SELECT id FROM setes_setes.tb_product WHERE tb_institution_id = 1 AND kind = 'S'
       AND active = 'S' AND deleted = 'N' ORDER BY id DESC LIMIT 1`)
  for (const c of clientes) {
    const r = await api('POST', '/service-orders', { customerId: c.id })
    if (r.status !== 201) continue
    const id = Number(r.body.data.id)
    await api('POST', `/service-orders/${id}/items`,
      { productId: Number(produto[0].id), quantity: 1, unitValue: 50 })
    ids.push(id)
  }
  return ids
}

async function main() {
  const alvo = Number(process.argv[2] ?? 12)
  console.log(`\nRE-PROVA — ${alvo} faturamentos CONCORRENTES de OS\n`)

  const ids = await abreOrdens(alvo)
  console.log(`ordens abertas: ${ids.length} (${ids[0]}..${ids[ids.length - 1]})`)

  const venc = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10)
  const inicio = Date.now()
  const resultados = await Promise.all(ids.map(id =>
    api('POST', `/service-orders/${id}/invoice`,
      { dtExpiration: venc, paymentTypeId: 6, parcels: 1 })
      .then(r => ({ id, status: r.status, code: r.body?.code, error: r.body?.error }))
      .catch(e => ({ id, status: 0, code: 'FETCH_FAIL', error: String(e?.message) }))))
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1)

  const ok   = resultados.filter(r => r.status === 201)
  const s500 = resultados.filter(r => r.status === 500)
  const s409 = resultados.filter(r => r.status === 409)
  const outros = resultados.filter(r => ![201, 409, 500].includes(r.status))

  console.log(`\nem ${segundos}s: ${ok.length} faturadas · ${s409.length} 409 · ${s500.length} 500 · ${outros.length} outros`)
  for (const r of [...s500, ...outros].slice(0, 5)) console.log('  !', r.id, r.status, r.code, r.error)
  for (const r of s409.slice(0, 3)) console.log('  409:', r.id, r.code)

  // a API continua respondendo? (H1: pool travado derrubava TUDO)
  const vivo = await api('GET', '/service-orders?status=A&page=1&pageSize=1')
  console.log(`API viva depois do teste: HTTP ${vivo.status}`)

  // data inválida (H3)
  const ruim = await api('POST', '/service-orders/batch-invoice',
    { orderIds: [ids[0]], dtExpiration: '2026-13-45', paymentTypeId: 6, parcels: 1 })
  console.log(`data 2026-13-45 no lote: HTTP ${ruim.status} ${ruim.body?.code ?? ''} ${ruim.body?.fields?.[0]?.field ?? ''}`)

  console.log(`\nVEREDITO: ${s500.length === 0 && vivo.status === 200 && ruim.status === 400 ? 'PASSOU' : 'FALHOU'}`)
  await pool.end()
}
main()
