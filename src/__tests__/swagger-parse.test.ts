/// <reference types="jest" />
// Cerca do contrato publicado (regra da casa: todo endpoint novo/alterado com @swagger válido — memória swagger-obrigatorio). O
// swagger-jsdoc NÃO falha num bloco @swagger que não é YAML válido: loga "Error in <arquivo>" e DESCARTA o bloco inteiro — gate do delta
// da Rodada 4 da F2a (F2AR4-SOC-01/ADV-08): `{kind, reason?, attempt}` sem aspas dentro de um mapa `{ description: … }` derrubou o
// `POST /api/billing/cancel` do /api-docs (a rota que a F2b chama) sem nenhum teste ver. Aqui o MESMO conjunto de arquivos e opções do
// spec servido, com `failOnErrors` — qualquer bloco quebrado em qualquer módulo derruba a suíte.
import swaggerJsdoc from 'swagger-jsdoc'
import { swaggerOptions } from '../shared/swagger/swagger-config'

describe('Swagger — todo bloco @swagger é YAML válido (nada é descartado em silêncio)', () => {
  it('o spec monta com failOnErrors (os mesmos arquivos e opções do /api-docs)', () => {
    expect(() => swaggerJsdoc({ ...swaggerOptions, failOnErrors: true })).not.toThrow()
  })

  it('as rotas do cancelamento que a F2b consome estão publicadas (com o 503 da voz e o 409 do bloqueio)', () => {
    const paths = (swaggerJsdoc({ ...swaggerOptions, failOnErrors: true }) as any).paths ?? {}
    expect(Object.keys(paths['/api/billing/cancel']?.post?.responses ?? {})).toEqual(expect.arrayContaining(['200', '409', '503']))
    expect(Object.keys(paths['/api/billing/{orderId}/cancel-plan']?.get?.responses ?? {})).toEqual(expect.arrayContaining(['200', '403', '409', '503']))
  })
})
