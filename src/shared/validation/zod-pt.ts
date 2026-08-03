import { z } from 'zod'

/**
 * Error map GLOBAL do Zod em PT-BR (Framework de Mensagens — mensagens
 * OBJETIVAS no fields[] do envelope 400). Sem ele, o parseBody devolve os
 * defaults técnicos em inglês ("String must contain at least 1 character(s)",
 * "Required"...) que chegam crus na tela do usuário.
 *
 * Ativado uma única vez no bootstrap (app.ts importa este módulo por efeito).
 * Mensagens explícitas nos DTOs (ex.: 'CPF inválido...') têm precedência —
 * o map só cobre o que o DTO não disse.
 */

const ptErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined' || issue.received === 'null') {
        return { message: 'Campo obrigatório' }
      }
      return { message: 'Valor com tipo inválido' }

    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') {
        return {
          message: Number(issue.minimum) <= 1
            ? 'Campo obrigatório'
            : `Informe pelo menos ${issue.minimum} caracteres`,
        }
      }
      if (issue.type === 'number') {
        return {
          message: issue.inclusive
            ? `Valor mínimo: ${issue.minimum}`
            : `Valor deve ser maior que ${issue.minimum}`,
        }
      }
      if (issue.type === 'array')  return { message: `Informe pelo menos ${issue.minimum} item(ns)` }
      break

    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `Informe no máximo ${issue.maximum} caracteres` }
      if (issue.type === 'number') {
        return {
          message: issue.inclusive
            ? `Valor máximo: ${issue.maximum}`
            : `Valor deve ser menor que ${issue.maximum}`,
        }
      }
      if (issue.type === 'array')  return { message: `Informe no máximo ${issue.maximum} item(ns)` }
      break

    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'E-mail inválido' }
      if (issue.validation === 'url')   return { message: 'URL inválida' }
      return { message: 'Formato inválido' }

    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Valor inválido — opções: ${issue.options.join(', ')}` }

    case z.ZodIssueCode.invalid_date:
      return { message: 'Data inválida' }
  }
  return { message: ctx.defaultError }
}

z.setErrorMap(ptErrorMap)
