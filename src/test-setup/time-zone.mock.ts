/// <reference types="jest" />
/**
 * Setup GLOBAL do jest (Q-TZ1, 2026-09-30): a zona do estabelecimento é lida
 * do Framework de Configurações (banco). Os testes de repositório simulam o
 * pool com respostas EM SEQUÊNCIA — a leitura da zona consumiria uma delas.
 * Aqui só a RESOLUÇÃO pelo banco é fixada no default (America/Sao_Paulo);
 * as funções puras (todayIn, dayStartUtc, nowIsoIn, toZoneWall, toUtcDb…)
 * seguem reais. A resolução REAL (pela conexão da transação, C1) é provada em
 * src/__tests__/time-zone-resolution.test.ts com jest.requireActual.
 */
jest.mock('@shared/time-zone', () => {
  const actual = jest.requireActual('@shared/time-zone')
  return {
    __esModule: true,
    ...actual,
    institutionZone:    jest.fn(async () => actual.DEFAULT_TIME_ZONE),
    institutionZoneFor: jest.fn(async () => actual.DEFAULT_TIME_ZONE),
    todayFor:           jest.fn(async (_s: string, _i: number, _q?: unknown, now?: Date) =>
      actual.todayIn(actual.DEFAULT_TIME_ZONE, now)),
  }
})
