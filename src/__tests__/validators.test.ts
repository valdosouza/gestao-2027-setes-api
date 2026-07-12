/// <reference types="jest" />
// Validadores compartilhados (Fase 2 campos configuráveis, decisão 18).
// As regras são ESPELHADAS no app (package setes_validators) — mudar aqui
// exige mudar lá.
import {
  isValidCpf, isValidCnpj, matchesMask, isOnlyDigits, stripNonDigits,
} from '../shared/validation'

describe('isValidCpf', () => {
  it.each(['52998224725', '11144477735'])('aceita CPF válido %s', cpf => {
    expect(isValidCpf(cpf)).toBe(true)
  })
  it.each([
    '52998224724',   // dígito verificador errado
    '11111111111',   // repetido
    '123',           // curto
    '529.982.247-25', // com máscara (decisão 19: sempre sem máscara)
    '',
  ])('rejeita %s', cpf => {
    expect(isValidCpf(cpf)).toBe(false)
  })
})

describe('isValidCnpj', () => {
  it.each(['11222333000181', '11444777000161'])('aceita CNPJ válido %s', cnpj => {
    expect(isValidCnpj(cnpj)).toBe(true)
  })
  it.each([
    '11222333000180',    // dígito verificador errado
    '00000000000000',    // repetido
    '12345678000199',    // dígito não confere
    '11.222.333/0001-81', // com máscara
  ])('rejeita %s', cnpj => {
    expect(isValidCnpj(cnpj)).toBe(false)
  })
})

describe('matchesMask (padrão # = dígito, A = letra, demais literais — decisão 16)', () => {
  it('valida fone no padrão da casa', () => {
    expect(matchesMask('(##) #-####-####', '(31) 9-8888-7777')).toBe(true)
    expect(matchesMask('(##) #-####-####', '(31) A-8888-7777')).toBe(false)
    expect(matchesMask('(##) #-####-####', '31988887777')).toBe(false) // literal ausente
  })
  it('valida letras com A e literais', () => {
    expect(matchesMask('AAA-####', 'ABC-1234')).toBe(true)
    expect(matchesMask('AAA-####', 'AB1-1234')).toBe(false)
  })
  it('máscara vazia/nula libera qualquer valor', () => {
    expect(matchesMask(null, 'qualquer')).toBe(true)
    expect(matchesMask('', '123')).toBe(true)
  })
})

describe('helpers', () => {
  it('isOnlyDigits', () => {
    expect(isOnlyDigits('123')).toBe(true)
    expect(isOnlyDigits('')).toBe(true)
    expect(isOnlyDigits('12a')).toBe(false)
  })
  it('stripNonDigits', () => {
    expect(stripNonDigits('(31) 9-8888-7777')).toBe('31988887777')
  })
})
