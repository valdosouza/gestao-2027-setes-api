/// <reference types="jest" />
/**
 * Setup GLOBAL do jest (costura A1 da auth-api — D-UC9/D-AU3, 2026-10-31): o middleware de autenticação lê a SESSÃO VIVA
 * (`setes_central.vw_user_link`) em TODA rota protegida. Os testes simulam o pool com respostas por SQL/sequência — a leitura da sessão
 * consumiria uma delas em centenas de testes que não são sobre ela. Aqui só a LEITURA da sessão é fixada no default: a sessão vale e o
 * perfil é o do token (o comportamento de antes da A1). O veredito (`accessVerdict`, `reachableKeys`, `accessRows`) segue REAL — os
 * testes de guarda respondem às views. A sessão REAL (401 SESSION_REVOKED, perfil vivo trocando o do token, 503 SESSION_UNAVAILABLE,
 * a fronteira do `iat` da D-EA7) é provada em `src/__tests__/adversarial-a1-gate.test.ts` com `jest.requireActual`; o par (hash, T) e o
 * `iat` passado à sessão, em `src/__tests__/password-set-at-d-ea7.test.ts`.
 */
jest.mock('@shared/access', () => {
  const actual = jest.requireActual('@shared/access')
  return {
    __esModule: true,
    ...actual,
    liveSession: jest.fn(async (payload: unknown) => payload),
  }
})
