/**
 * Smoke da PESQUISA AVANÇADA (Infra-IA/prompts/prompt_pesquisa_avancada.md)
 * contra a API real do dev — prova que o SQL compilado roda no MariaDB e que
 * o COUNT acompanha a página. Somente leitura: não grava nada.
 *
 *   npx tsx --require tsconfig-paths/register scripts/smoke-pesquisa-avancada.ts
 */
import 'dotenv/config'
import jwt from 'jsonwebtoken'
import pool from '../src/shared/db/connection'

const BASE = process.env.SMOKE_API ?? 'http://localhost:3000'
const token = jwt.sign(
  { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' },
  process.env.JWT_SECRET!, { expiresIn: '10m' })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const q = (criteria: unknown, extra = '') =>
  `?pageSize=200&criteria=${encodeURIComponent(JSON.stringify(criteria))}${extra}`

async function main(): Promise<void> {
  // --- catálogos
  const cc = await get('/api/customers/search-criteria')
  check('customers/search-criteria 200', cc.status === 200, `keys=${cc.body?.data?.map((c: any) => c.key).join(',')}`)
  check('customers: nenhuma expressão SQL vazada', !JSON.stringify(cc.body).includes('expr') && !JSON.stringify(cc.body).includes('SELECT'))
  const sc = await get('/api/service-orders/search-criteria')
  check('service-orders/search-criteria 200', sc.status === 200, `keys=${sc.body?.data?.map((c: any) => c.key).join(',')}`)

  // --- customers: total sem critério x com critério (conferência no banco)
  const all = await get('/api/customers?pageSize=200')
  check('customers lista sem critério', all.status === 200, `total=${all.body?.total}`)

  const pj = await get(`/api/customers${q({ personType: ['J'] })}`)
  const [[{ n: pjDb }]] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n FROM setes_setes.tb_customer c
      WHERE c.tb_institution_id = 1 AND c.deleted = 'N'
        AND EXISTS (SELECT 1 FROM setes_central.tb_company co WHERE co.id = c.id AND co.deleted = 'N')
        AND NOT EXISTS (SELECT 1 FROM setes_central.tb_person p WHERE p.id = c.id AND p.deleted = 'N')`)
  check('customers personType=J confere com o banco', pj.status === 200 && pj.body.total === Number(pjDb),
    `api=${pj.body?.total} banco=${pjDb}`)

  const active = await get(`/api/customers${q({ active: true })}`)
  const inactive = await get(`/api/customers${q({ active: false })}`)
  check('customers ativo + inativo = total', active.body.total + inactive.body.total === all.body.total,
    `${active.body.total} + ${inactive.body.total} = ${all.body.total}`)

  // documento de um cliente real → acha exatamente ele
  const [[docRow]] = await pool.query<any[]>(
    `SELECT c.id, co.cnpj FROM setes_setes.tb_customer c
       JOIN setes_central.tb_company co ON co.id = c.id
      WHERE c.tb_institution_id = 1 AND c.deleted = 'N' AND co.cnpj <> '0' LIMIT 1`)
  if (docRow) {
    const masked = `${docRow.cnpj.slice(0, 2)}.${docRow.cnpj.slice(2, 5)}.${docRow.cnpj.slice(5, 8)}/${docRow.cnpj.slice(8, 12)}-${docRow.cnpj.slice(12)}`
    const byDoc = await get(`/api/customers${q({ document: masked })}`)
    check('customers documento com máscara acha o cliente', byDoc.status === 200 && byDoc.body.data.some((r: any) => r.id === docRow.id),
      `total=${byDoc.body?.total}`)
  }

  const combined = await get(`/api/customers${q({ personType: ['J'], active: true, createdAt: { from: '2000-01-01' } }, '&filter=a')}`)
  check('customers critérios + filtro rápido combinam (200)', combined.status === 200 && combined.body.total <= pj.body.total,
    `total=${combined.body?.total}`)

  // --- Q-BA12: cidade casa com QUALQUER endereço principal
  const [[cityRow]] = await pool.query<any[]>(
    `SELECT ci.name, COUNT(DISTINCT c.id) AS n
       FROM setes_setes.tb_customer c
       JOIN setes_central.tb_address a ON a.id = c.id AND a.main = 'S' AND a.deleted = 'N'
       JOIN setes_central.tb_city ci ON ci.id = a.tb_city_id
      WHERE c.tb_institution_id = 1 AND c.deleted = 'N'
      GROUP BY ci.name ORDER BY n DESC LIMIT 1`)
  if (cityRow) {
    const [[{ n: cityDb }]] = await pool.query<any[]>(
      `SELECT COUNT(DISTINCT c.id) AS n FROM setes_setes.tb_customer c
         JOIN setes_central.tb_address a ON a.id = c.id AND a.main = 'S' AND a.deleted = 'N'
         JOIN setes_central.tb_city ci ON ci.id = a.tb_city_id
        WHERE c.tb_institution_id = 1 AND c.deleted = 'N' AND ci.name LIKE ?`, [`%${cityRow.name}%`])
    const byCity = await get(`/api/customers${q({ city: cityRow.name })}`)
    check('cidade (qualquer endereço principal) confere com o banco', byCity.status === 200 && byCity.body.total === Number(cityDb),
      `${cityRow.name}: api=${byCity.body?.total} banco=${cityDb}`)
  }

  // --- Q-BA14: data de cadastro (DATETIME) pelo fuso do estabelecimento
  const [[dayRow]] = await pool.query<any[]>(
    `SELECT DATE_FORMAT(c.created_at, '%Y-%m-%d') AS d FROM setes_setes.tb_customer c
      WHERE c.tb_institution_id = 1 AND c.deleted = 'N' AND c.created_at IS NOT NULL
      ORDER BY c.created_at DESC LIMIT 1`)
  if (dayRow) {
    const [[{ n: dayDb }]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n FROM setes_setes.tb_customer c
        WHERE c.tb_institution_id = 1 AND c.deleted = 'N' AND DATE(c.created_at) = ?`, [dayRow.d])
    const byDay = await get(`/api/customers${q({ createdAt: { from: dayRow.d, to: dayRow.d } })}`)
    check('cadastro num dia (DATETIME, servidor em America/Sao_Paulo) confere com o banco',
      byDay.status === 200 && byDay.body.total === Number(dayDb), `${dayRow.d}: api=${byDay.body?.total} banco=${dayDb}`)
  }
  const tzCatalog = await get('/api/interface-configs/key/establishment')
  check('config time_zone servida na interface establishment', JSON.stringify(tzCatalog.body ?? {}).includes('time_zone'),
    `status=${tzCatalog.status}`)

  // --- erros
  const unknown = await get(`/api/customers${q({ hack: 1 })}`)
  check('chave desconhecida = 400 SEARCH_CRITERIA_INVALID', unknown.status === 400 && unknown.body.code === 'SEARCH_CRITERIA_INVALID')
  const bad = await get(`/api/customers${q({ createdAt: { from: '2026-12-01', to: '2026-01-01' } })}`)
  check('faixa invertida = 422 com fields[createdAt]', bad.status === 422 && bad.body.fields?.[0]?.field === 'createdAt')
  const malformed = await get('/api/customers?criteria=%7Bnope')
  check('JSON malformado = 400', malformed.status === 400)
  const other = await get(`/api/cities${q({ a: 1 })}`)
  check('módulo sem critérios + criteria = 400', other.status === 400, `status=${other.status}`)

  // --- service-orders
  const soAll = await get('/api/service-orders?status=F&pageSize=200')
  const first = soAll.body?.data?.[0]
  check('service-orders faturadas', soAll.status === 200, `total=${soAll.body?.total}`)
  if (first) {
    const byCustomer = await get(`/api/service-orders${q({ customer: first.customerId }, '&status=F')}`)
    check('service-orders por cliente: todas do cliente', byCustomer.status === 200
      && byCustomer.body.data.every((r: any) => r.customerId === first.customerId) && byCustomer.body.total >= 1,
      `total=${byCustomer.body?.total}`)
    const byNumber = await get(`/api/service-orders${q({ number: { from: first.number, to: first.number } }, '&status=F')}`)
    check('service-orders faixa de número exata', byNumber.status === 200 && byNumber.body.total === 1)
    const byValue = await get(`/api/service-orders${q({ totalValue: { from: 0 }, dtRecord: { to: '2100-12-31' } }, '&status=F')}`)
    check('service-orders valor + período cobrem tudo', byValue.status === 200 && byValue.body.total === soAll.body.total,
      `${byValue.body?.total} de ${soAll.body.total}`)
  }
  const lookup = await get('/api/service-orders/customer-lookup?filter=a')
  check('service-orders/customer-lookup 200 {id,name}', lookup.status === 200
    && (lookup.body.data.length === 0 || ('id' in lookup.body.data[0] && 'name' in lookup.body.data[0])),
    `n=${lookup.body?.data?.length}`)

  console.log(failures ? `\n${failures} FALHA(S)` : '\nTUDO OK')
  await pool.end()
  process.exit(failures ? 1 : 0)
}

main().catch(async err => { console.error(err); await pool.end(); process.exit(1) })
