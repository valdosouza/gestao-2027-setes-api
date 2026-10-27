/**
 * Setup GLOBAL do jest (D-PV29 — cache do veredito de privilégio, `@shared/auth/require-privilege`): a suíte roda com o cache
 * DESLIGADO — os testes de guarda contam as consultas ao dublê do banco por requisição e trocam o vínculo entre duas chamadas
 * (o cache ligado faria o 2º pedido reler o veredito anterior). O teste do próprio cache (`privilege-verdict-cache.test.ts`)
 * liga o TTL pelo ambiente antes de cada chamada — o TTL é lido a cada veredito.
 */
process.env.PRIVILEGE_VERDICT_CACHE_TTL_MS = '0'
