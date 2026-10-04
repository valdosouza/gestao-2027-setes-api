/**
 * Smoke da PESQUISA AVANÇADA — Onda 2 / Bloco 1 (Infra-IA/prompts/prompt_pesquisa_avancada.md §12)
 * contra a API real do dev. SOMENTE LEITURA. Prova, por módulo:
 *  - GET /<m>/search-criteria responde 200 sem expressão SQL e com o critério de NOME (D-BA21);
 *  - a lista aceita TODOS os critérios juntos e cada um sozinho (200, total ≤ lista cheia);
 *  - sim/não: ativo + inativo = total (o fragmento só ESTREITA);
 *  - lookups respondem { id, name } e o id escolhido entra na lista (200);
 *  - chave desconhecida = 400; valor inválido = 422 com fields[];
 *  - users: "instituição" só com Super, "kind" só com vínculo em foco; lookup só Super (403 p/ admin).
 *
 *   npx tsx --require tsconfig-paths/register scripts/smoke-pesquisa-avancada-onda2.ts
 */
import 'dotenv/config'
import jwt from 'jsonwebtoken'

const BASE = process.env.SMOKE_API ?? 'http://localhost:3000'
const sign = (payload: object) => jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '10m' })
const SUPER = sign({ institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' })
// admin FICTÍCIO da mesma institution: só muda o role do JWT (users.scopeOf lê isSuper do payload)
const ADMIN = sign({ institutionId: 1, userId: 1, role: 'admin', schemaName: 'setes_setes' })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function get(path: string, token = SUPER): Promise<{ status: number; body: any }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 429 && attempt < 2) {   // rate limit do gateway (300 req/min) — espera a janela
      console.log('  … 429 do rate limit, aguardando 65 s')
      await new Promise(r => setTimeout(r, 65_000))
      continue
    }
    return { status: res.status, body: await res.json().catch(() => null) }
  }
}
const q = (criteria: unknown, extra = '') =>
  `?pageSize=200&criteria=${encodeURIComponent(JSON.stringify(criteria))}${extra}`

interface Criterion { key: string; kind: string; lookup?: string; options?: string[] }

function sampleFor(c: Criterion): unknown {
  switch (c.kind) {
    case 'text':    return c.key === 'document' ? '1' : 'a'   // documento compara só dígitos
    case 'number':  return { from: 0, to: 1000000 }
    case 'money':   return { from: 0, to: 1000000 }
    case 'date':    return { from: '2000-01-01', to: '2099-12-31' }
    case 'lookup':  return 1
    case 'options': return c.options ?? []
    case 'bool':    return true
    default:        return null
  }
}

/** módulo → chave do critério de NOME (D-BA21) */
const MODULES: Record<string, string> = {
  carriers: 'name', collaborators: 'name', providers: 'name', salesmen: 'name', institutions: 'name',
  users: 'name', contracts: 'customerName', 'bank-accounts': 'bankName', 'bank-charge-agreements': 'agreement',
  'settlement-rules': 'paymentTypeName', 'payment-types': 'description', 'price-lists': 'description',
  services: 'description', customers: 'name',
}

async function smokeModule(mod: string, nameKey: string): Promise<void> {
  console.log(`\n=== ${mod}`)
  // users: o critério `kind` só existe COM foco — lista e catálogo recebem o mesmo institutionId
  const focus = mod === 'users' ? '&institutionId=1' : ''
  const cat = await get(`/api/${mod}/search-criteria${mod === 'users' ? '?institutionId=1' : ''}`)
  const raw = JSON.stringify(cat.body ?? '')
  check(`${mod}/search-criteria 200`, cat.status === 200, `keys=${cat.body?.data?.map((c: any) => c.key).join(',')}`)
  check(`${mod}: nenhuma expressão vazada`, !raw.includes('"expr"') && !raw.includes('SELECT') && !raw.includes('"shape"'))
  const defs: Criterion[] = cat.body?.data ?? []
  check(`${mod}: critério de nome "${nameKey}" é texto (D-BA21)`, defs.some(d => d.key === nameKey && d.kind === 'text'))
  for (const d of defs) check(`${mod}.${d.key}: labelKey search.${mod}.${d.key}`, (cat.body.data.find((x: any) => x.key === d.key).labelKey) === `search.${mod}.${d.key}`)

  const all = await get(`/api/${mod}?pageSize=200${focus}`)
  check(`${mod} lista sem critério 200`, all.status === 200, `total=${all.body?.total}`)
  const total = Number(all.body?.total ?? -1)

  // todos juntos
  const every = Object.fromEntries(defs.map(d => [d.key, sampleFor(d)]))
  const withAll = await get(`/api/${mod}${q(every, focus)}`)
  check(`${mod} TODOS os critérios 200 e total ≤ cheia`, withAll.status === 200 && withAll.body.total <= total,
    `status=${withAll.status} total=${withAll.body?.total}${withAll.status !== 200 ? ' ' + JSON.stringify(withAll.body) : ''}`)

  // cada um sozinho
  for (const d of defs) {
    const one = await get(`/api/${mod}${q({ [d.key]: sampleFor(d) }, focus)}`)
    check(`${mod}.${d.key} sozinho 200 e total ≤ cheia`, one.status === 200 && one.body.total <= total,
      `status=${one.status} total=${one.body?.total}${one.status !== 200 ? ' ' + JSON.stringify(one.body) : ''}`)
    if (d.kind === 'bool') {
      const no = await get(`/api/${mod}${q({ [d.key]: false }, focus)}`)
      check(`${mod}.${d.key}: sim + não = total`, one.body.total + no.body.total === total,
        `${one.body.total} + ${no.body?.total} = ${total}`)
    }
    if (d.kind === 'lookup' && d.lookup) {
      const lk = await get(`${d.lookup}?filter=`)
      const rows: any[] = lk.body?.data ?? []
      check(`${mod}.${d.key}: lookup ${d.lookup} 200 com { id, name }`,
        lk.status === 200 && Array.isArray(rows) && rows.every(r => typeof r.id === 'number' && 'name' in r),
        `n=${rows.length}${rows[0] ? ` 1º=${JSON.stringify(rows[0])}` : ''}`)
      if (rows[0]) {
        const byId = await get(`/api/${mod}${q({ [d.key]: rows[0].id }, focus)}`)
        check(`${mod}.${d.key}: id ${rows[0].id} do lookup entra na lista`, byId.status === 200 && byId.body.total <= total, `total=${byId.body?.total}`)
      }
    }
  }

  // erros legíveis
  const unknown = await get(`/api/${mod}${q({ naoExiste: 1 }, focus)}`)
  check(`${mod}: chave desconhecida = 400 SEARCH_CRITERIA_INVALID`, unknown.status === 400 && unknown.body?.code === 'SEARCH_CRITERIA_INVALID')
  const firstRange = defs.find(d => ['number', 'money', 'date'].includes(d.kind))
  if (firstRange) {
    const bad = await get(`/api/${mod}${q({ [firstRange.key]: { from: 'x' } }, focus)}`)
    check(`${mod}.${firstRange.key}: valor inválido = 422 com fields[]`,
      bad.status === 422 && bad.body?.fields?.[0]?.field === firstRange.key, `status=${bad.status}`)
  }
}

async function main(): Promise<void> {
  for (const [mod, nameKey] of Object.entries(MODULES)) await smokeModule(mod, nameKey)

  console.log('\n=== users — vínculo em foco × pertence a (parecer do guardião, D-BA24)')
  const noFocus = await get('/api/users/search-criteria')
  const keysNoFocus = noFocus.body?.data?.map((c: any) => c.key) ?? []
  check('super SEM foco: institution sim, kind não', keysNoFocus.includes('institution') && !keysNoFocus.includes('kind'), keysNoFocus.join(','))
  const focus = await get('/api/users/search-criteria?institutionId=1')
  const keysFocus = focus.body?.data?.map((c: any) => c.key) ?? []
  check('super COM foco: institution e kind', keysFocus.includes('institution') && keysFocus.includes('kind'), keysFocus.join(','))
  const admin = await get('/api/users/search-criteria', ADMIN)
  const keysAdmin = admin.body?.data?.map((c: any) => c.key) ?? []
  check('admin: kind sim, institution não', keysAdmin.includes('kind') && !keysAdmin.includes('institution'), keysAdmin.join(','))
  const lkAdmin = await get('/api/users/institution-lookup?filter=', ADMIN)
  check('admin no lookup de instituições = 403', lkAdmin.status === 403, `status=${lkAdmin.status}`)
  const lkSuper = await get('/api/users/institution-lookup?filter=')
  check('super no lookup de instituições = 200 { id, name }', lkSuper.status === 200 && lkSuper.body.data.every((r: any) => 'name' in r),
    `n=${lkSuper.body?.data?.length}`)
  const inst1 = await get(`/api/users${q({ institution: 1 })}`)
  const allUsers = await get('/api/users?pageSize=200')
  check('users pertence à institution 1 ≤ todos', inst1.status === 200 && inst1.body.total <= allUsers.body.total,
    `${inst1.body?.total} ≤ ${allUsers.body?.total}`)
  const kindAdmin = await get(`/api/users${q({ kind: ['admin'] }, '&institutionId=1')}`)
  const kindUser = await get(`/api/users${q({ kind: ['user'] }, '&institutionId=1')}`)
  const kindSuper = await get(`/api/users${q({ kind: ['super'] }, '&institutionId=1')}`)
  const focused = await get('/api/users?pageSize=200&institutionId=1')
  check('users kind admin + user + super = vinculados à 1',
    kindAdmin.body.total + kindUser.body.total + kindSuper.body.total === focused.body.total,
    `${kindAdmin.body?.total} + ${kindUser.body?.total} + ${kindSuper.body?.total} = ${focused.body?.total}`)

  console.log('\n=== gate adversarial (2026-10-03): catálogo servido = catálogo aceito; foco inválido = 400')
  const adminInst = await get(`/api/users${q({ institution: 1 })}`, ADMIN)
  check('admin mandando "institution" = 400 (não servido → não aceito)', adminInst.status === 400 && adminInst.body?.code === 'SEARCH_CRITERIA_INVALID', `status=${adminInst.status}`)
  const superKind = await get(`/api/users${q({ kind: ['admin'] })}`)
  check('super SEM foco mandando "kind" = 400', superKind.status === 400, `status=${superKind.status}`)
  const badFocus = await get('/api/users?institutionId=abc')
  check('users?institutionId=abc = 400 (era 500)', badFocus.status === 400 && badFocus.body?.fields?.[0]?.field === 'institutionId', `status=${badFocus.status}`)
  const badFocusCat = await get('/api/users/search-criteria?institutionId=-1')
  check('users/search-criteria?institutionId=-1 = 400', badFocusCat.status === 400, `status=${badFocusCat.status}`)
  const okFocus = await get('/api/users?institutionId=1&pageSize=200')
  check('users?institutionId=1 segue 200', okFocus.status === 200, `total=${okFocus.body?.total}`)

  console.log(`\n${failures ? 'REPROVADO' : 'APROVADO'}: ${failures} falha(s)`)
  process.exit(failures ? 1 : 0)
}

main().catch(err => { console.error('ERRO:', err?.message ?? err); process.exit(1) })
