/// <reference types="jest" />
// D-PV2/D-PV7/D-PV8 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): o mapa REAL do gateway — quais módulos passam
// pela guarda por roteador, o privilégio de cada ato de processo e as exceções nomeadas. Cerca: rota nova com POST (onde os
// atos se escondem) precisa ser classificada aqui — criação (INSERIR pelo verbo) ou ato (`privilegeAct`).
import fs from 'fs'
import path from 'path'
import router from '../gateway/router'
import { listGatedRoutes, listGatedModules } from '../shared/auth/module-privilege-gate'
import {
  PRIVILEGE_INSERIR as I, PRIVILEGE_ALTERAR as A, PRIVILEGE_EXCLUIR as E, PRIVILEGE_IMPRIMIR as P, PRIVILEGE_FATURAR as F,
  PRIVILEGE_VISUALIZAR as V, PRIVILEGE_CANCELAR as C, PRIVILEGE_TRANSMITIR as T,
} from '../shared/auth/privileges'

void router                                                     // montar o gateway registra as guardas

const rows = listGatedRoutes()
const at = (m: string, method: string, path: string) => {
  const r = rows.find(x => x.moduleKey === m && x.method === method && x.path === path)
  if (!r) throw new Error(`rota ausente: ${m} ${method} ${path}`)
  return [r.privilegeId, r.interfaces.join('|')]
}

describe('módulos sob a guarda por roteador', () => {
  it('as 25 telas do cliente + a tela do Super delegável (D-PV11) — e só elas', () => {
    expect([...listGatedModules()].sort()).toEqual([
      'bank-accounts', 'bank-charge-agreements', 'bank-slips', 'carriers', 'cashier', 'categories', 'checks', 'collaborators',
      'contracts', 'customers', 'financial-plans', 'institution-interfaces', 'interface-configs', 'interface-fields', 'order-returns', 'orders',
      'payment-types', 'price-lists', 'providers', 'salesmen', 'service-orders', 'service-tax-rules', 'services',
      'settlement-rules', 'settlements', 'tax-rules',
    ])
  })
  it('fora da guarda por NOME: core, erp, admin, entities, billing, geográficos, Super, perfil admin, modules, state-tax-rates', () => {
    for (const k of ['core', 'erp', 'admin', 'entities', 'billing', 'countries', 'states', 'cities', 'interfaces', 'privileges',
      'cfop', 'service-list', 'banks', 'institutions', 'users', 'establishment', 'modules', 'state-tax-rates']) {
      expect([k, listGatedModules().includes(k)]).toEqual([k, false])
    }
  })
})

describe('cerca do gateway: tudo que está MONTADO é guardado OU exceção nomeada (falha fechada por omissão)', () => {
  // Gate socrático da D-PV2: a lista dos 25 não pega o módulo NOVO montado sem `gatedModule` — esta lê o gateway.
  const EXCEPTIONS = new Set(['core', 'erp', 'admin', 'entities', 'billing', 'countries', 'states', 'cities', 'interfaces',
    'privileges', 'cfop', 'service-list', 'banks', 'institutions', 'users', 'modules', 'establishment', 'state-tax-rates'])
  const src = fs.readFileSync(path.join(__dirname, '..', 'gateway', 'router.ts'), 'utf8')
  const mounts = [...src.matchAll(/^\s*router\.use\(\s*'\/([a-z0-9-]+)'\s*,([^\r\n]*)\)/gm)].map(m => ({ key: m[1], rest: m[2] }))

  it('o gateway monta exatamente os guardados + as exceções nomeadas — nada fora das duas listas', () => {
    expect(mounts.length).toBeGreaterThan(40)
    // montagem escrita em mais de uma linha (ou fora do padrão) não escapa: todo `router.use(` do arquivo foi lido
    expect(mounts.length).toBe((src.match(/^\s*router\.use\(/gm) ?? []).length)
    const strays = mounts.filter(m => !EXCEPTIONS.has(m.key) && !/gatedModule\(\s*'([a-z0-9-]+)'/.test(m.rest))
    expect(strays.map(m => m.key)).toEqual([])
  })
  it('cada guardado monta com a SUA chave (a URL = a interface) e toda chave de `gatedModule` está montada', () => {
    for (const m of mounts) {
      const g = /gatedModule\(\s*'([a-z0-9-]+)'/.exec(m.rest)
      if (g) expect([m.key, g[1]]).toEqual([m.key, m.key])
    }
    expect([...listGatedModules()].sort()).toEqual(mounts.filter(m => /gatedModule\(/.test(m.rest)).map(m => m.key).sort())
  })
  it('o app monta em /api SÓ o gateway (nenhuma rota de tela pendurada em app.ts por fora da cerca)', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.ts'), 'utf8')
    const apiMounts = [...appSrc.matchAll(/app\.use\(\s*'(\/api[^']*)'\s*,\s*([A-Za-z]+)/g)].map(m => `${m[1]} ${m[2]}`)
    expect(apiMounts).toEqual(['/api authMiddleware', '/api featureFlagMiddleware', '/api rateLimitMiddleware', '/api apiRouter'])
  })
  it('D-PV11: só a tela do Super delegável usa a guarda DELEGADA (veredito da delegação, sem licença)', () => {
    const delegated = [...new Set(rows.filter(r => r.delegatedSuper).map(r => r.moduleKey))]
    expect(delegated).toEqual(['institution-interfaces'])
    expect(rows.filter(r => r.moduleKey === 'institution-interfaces').map(r => `${r.method} ${r.path} ${r.privilegeId}`).sort())
      .toEqual(['GET / 6', 'GET /:id 6', 'PUT /:id 2'])
  })
  it('exceção nomeada nunca é guardada por engano (as duas listas não se cruzam)', () => {
    expect(listGatedModules().filter(k => EXCEPTIONS.has(k))).toEqual([])
  })
})

describe('atos de processo (D-PV7) e rotina mensal/excluir OS (D-PV8)', () => {
  it.each([
    ['settlements', 'POST', '/', I], ['settlements', 'POST', '/reversal', E], ['settlements', 'PUT', '/bills/:orderId/:parcel/charge', A],
    ['bank-slips', 'POST', '/', I], ['bank-slips', 'POST', '/:id/settle', A], ['bank-slips', 'POST', '/:id/cancel', C],
    ['bank-slips', 'POST', '/:id/reverse', C], ['bank-slips', 'POST', '/:id/register', T], ['bank-slips', 'GET', '/:id/pdf', P],
    ['bank-slips', 'POST', '/refresh', T], ['bank-slips', 'POST', '/:id/refresh', T], ['bank-slips', 'POST', '/:id/pay-sandbox', T],
    ['bank-slips', 'POST', '/:id/reapply', T],
    ['checks', 'POST', '/:id/deposit', A], ['checks', 'POST', '/:id/discount', A], ['checks', 'POST', '/:id/return-refund', A],
    ['checks', 'POST', '/:id/return-good', A], ['checks', 'POST', '/:id/pay', A], ['checks', 'POST', '/:id/return', A],
    ['checks', 'POST', '/:id/reverse', C],
    ['cashier', 'POST', '/open', I], ['cashier', 'POST', '/:id/withdraw', A], ['cashier', 'POST', '/:id/close', A],
    ['service-orders', 'POST', '/monthly-run', F], ['service-orders', 'DELETE', '/:id', E],
    ['service-orders', 'POST', '/:id/invoice', F], ['service-orders', 'POST', '/batch-invoice', F],
    ['orders', 'DELETE', '/:id', E], ['order-returns', 'DELETE', '/:id', E],
  ] as const)('%s %s %s → privilégio %i da própria tela', (m, method, path, pid) => {
    expect(at(m, method, path)).toEqual([pid, m])
  })

  it('canal API da conta bancária (inventário: "canal = A"): toda escrita = ALTERAR; as leituras = VISUALIZAR', () => {
    for (const [method, path] of [['PUT', '/:id/channel'], ['DELETE', '/:id/channel'], ['PUT', '/:id/channel/secrets'],
      ['DELETE', '/:id/channel/secrets'], ['POST', '/:id/channel/rotate-token'], ['POST', '/:id/channel/test'],
      ['PUT', '/:id/channel/webhook'], ['DELETE', '/:id/channel/webhook']]) {
      expect([method, path, ...at('bank-accounts', method, path)]).toEqual([method, path, A, 'bank-accounts'])
    }
    expect(at('bank-accounts', 'GET', '/:id/channel')).toEqual([V, 'bank-accounts'])
    expect(at('bank-accounts', 'GET', '/:id/channel/webhook')).toEqual([V, 'bank-accounts'])
  })
})

describe('outra interface e exceções nomeadas', () => {
  it('A-PV2: a aba Parceria (e a lista de apoio dela) confere a interface kind R `partnerships`', () => {
    expect(at('customers', 'GET', '/:id/partnership')).toEqual([V, 'partnerships'])
    expect(at('customers', 'PUT', '/:id/partnership')).toEqual([A, 'partnerships'])
    expect(at('customers', 'GET', '/collaborator-lookup')).toEqual([V, 'partnerships'])
  })
  it('A-PV8: o painel de configs aceita o privilégio da "Configurações Gerais" (dinâmico no painel dela)', () => {
    expect(at('interface-configs', 'GET', '/')).toEqual([V, 'interface-configs|general-configs'])
    const panel = rows.filter(r => r.moduleKey === 'interface-configs' && ['/:id', '/:id/:name'].includes(r.path))
    expect(panel.map(r => [r.method, r.privilegeId, r.dynamic, r.interfaces.join('|')])).toEqual([
      ['GET', V, true, 'interface-configs|general-configs'], ['PUT', A, true, 'interface-configs|general-configs'],
    ])
  })
  it('D-PV2/A-PV6: as leituras de motor por chave e o override pessoal por chave são ABERTOS — e só elas', () => {
    const open = rows.filter(r => r.privilegeId === null).map(r => `${r.moduleKey} ${r.method} ${r.path}`).sort()
    expect(open).toEqual([
      'interface-configs GET /key/:moduleKey', 'interface-configs PUT /key/:moduleKey/:name', 'interface-fields GET /key/:moduleKey',
    ])
  })
  it('D-PV6: salvar o campo configurável = ALTERAR do painel de campos', () => {
    expect(at('interface-fields', 'PUT', '/:id/:fieldName')).toEqual([A, 'interface-fields'])
  })
})

describe('cerca: POST sem marcador = CRIAÇÃO (INSERIR pelo verbo) — rota nova tem de ser classificada aqui', () => {
  it('a lista fechada dos POST que valem INSERIR', () => {
    const creation = rows.filter(r => r.method === 'POST' && r.privilegeId === I).map(r => `${r.moduleKey} ${r.path}`).sort()
    expect(creation).toEqual([
      'bank-accounts /', 'bank-charge-agreements /', 'bank-slips /', 'carriers /', 'cashier /open', 'categories /',
      'collaborators /', 'contracts /', 'customers /', 'financial-plans /', 'order-returns /', 'orders /', 'orders /:id/items',
      'payment-types /', 'price-lists /', 'providers /', 'salesmen /', 'service-orders /', 'service-orders /:id/items',
      'service-tax-rules /', 'services /', 'settlement-rules /', 'settlements /', 'tax-rules /',
    ])
  })
  it('todo privilégio exigido existe no catálogo de privilégios (1..9) e toda rota guardada tem um (exceto as abertas)', () => {
    for (const r of rows) {
      if (r.privilegeId === null) continue
      expect([r.moduleKey, r.method, r.path, [I, A, E, P, F, V, C, 8, T].includes(r.privilegeId)])
        .toEqual([r.moduleKey, r.method, r.path, true])
    }
  })
})
