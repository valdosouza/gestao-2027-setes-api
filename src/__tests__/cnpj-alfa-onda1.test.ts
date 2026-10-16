/// <reference types="jest" />
// Frente do CNPJ alfanumérico — ONDA 1 no setes-api (D-CJ3/D-CJ8, Valdo 2026-10-16; `Infra-IA/prompts/prompt_frente_cnpj_alfanumerico.md` §8.8):
// a PORTA de escrita dos 5 papéis (institution, cliente, fornecedor, transportadora, colaborador) ABRE para o CNPJ alfanumérico na forma
// CANÔNICA — e só para ela; fora da forma, a recusa diz o motivo e, quando dá, a forma ESPERADA em `fields[].expected` (texto, aditivo à D-N3).
import { z } from 'zod'
import { companyBody, personBody } from '../shared/fiscal/fiscal.dto'
import { zodToFields } from '../shared/http/controller-utils'
import { customerCreateDto } from '../modules/customers/customers.dto'

const fieldsOf = (schema: z.ZodTypeAny, body: unknown) => {
  const r = schema.safeParse(body)
  return r.success ? [] : zodToFields(r.error)
}

describe('D-CJ8 — a porta do cadastro aceita o CNPJ alfanumérico canônico', () => {
  it.each(['PC3D315K000193', '12ABC34501DE35', '00000000E08G12', '07742094000113'])('%s passa (DV ASCII − 48)', cnpj => {
    expect(companyBody.safeParse({ cnpj }).success).toBe(true)
  })
  it('um papel inteiro (cliente PJ) com CNPJ alfanumérico passa o DTO', () => {
    expect(customerCreateDto.safeParse({ personType: 'J', company: { cnpj: 'PC3D315K000193' }, entity: { nameCompany: 'Empresa Nova', nickTrade: 'Nova' } }).success).toBe(true)
  })
})

describe('D-CJ3 — fora da forma canônica: recusa com o motivo certo e a forma ESPERADA quando dá', () => {
  it.each([
    ['máscara', '12.ABC.345/01DE-35', '12ABC34501DE35'],
    ['minúscula', 'pc3d315k000193', 'PC3D315K000193'],
    ['espaço nas pontas', ' PC3D315K000193 ', 'PC3D315K000193'],
    ['máscara numérica', '07.742.094/0001-13', '07742094000113'],
  ])('%s → fields[].expected = %s', (_l, cnpj, expected) => {
    expect(fieldsOf(companyBody, { cnpj })).toEqual([
      { field: 'cnpj', message: 'CNPJ fora da forma canônica — envie sem máscara e com letras maiúsculas', expected },
    ])
  })
  it.each([
    ['DV errado (numérico)', '12345678000199', /dígito verificador não confere/],
    ['DV errado (alfanumérico)', 'PC3D315K000194', /dígito verificador não confere/],
    ['letra no DV', 'PC3D315K00019Z', /12 letras ou números e 2 dígitos verificadores/],
    ['acento', 'PC3D315K00019É', /12 letras ou números e 2 dígitos verificadores/],
    ['13 posições', 'PC3D315K00019', /12 letras ou números e 2 dígitos verificadores/],
  ])('%s → sem expected (não há forma canônica válida a sugerir)', (_l, cnpj, message) => {
    const f = fieldsOf(companyBody, { cnpj })
    expect(f).toHaveLength(1)
    expect(f[0].message).toMatch(message)
    expect(f[0]).not.toHaveProperty('expected')
  })
  it('máscara sobre um CNPJ de DV errado NÃO sugere a forma (sugerir seria aceitar um CNPJ inválido)', () => {
    const f = fieldsOf(companyBody, { cnpj: '12.345.678/0001-99' })
    expect(f[0].message).toMatch(/dígito verificador não confere/)
    expect(f[0]).not.toHaveProperty('expected')
  })
  it('CPF segue numérico, com a mesma regra de forma esperada', () => {
    expect(personBody.safeParse({ cpf: '52998224725' }).success).toBe(true)
    expect(fieldsOf(personBody, { cpf: '529.982.247-25' })).toEqual([
      { field: 'cpf', message: 'CPF fora da forma canônica — envie sem máscara', expected: '52998224725' },
    ])
    expect(fieldsOf(personBody, { cpf: '5299822472A' })[0].message).toMatch(/11 dígitos numéricos/)
  })
})
