import { z } from 'zod'

/**
 * DTO (Zod) do módulo services. Tamanhos espelham o DDL da tb_product
 * (identifier 50, description 100). prices[]: priceTag null = remover o
 * preço da tabela; priceListId duplicado é rejeitado.
 */

const sn = z.enum(['S', 'N'])

const priceDto = z.object({
  priceListId: z.number().int().positive(),
  priceTag:    z.number().min(0).nullable(),
})

export const serviceDto = z.object({
  identifier:       z.string().max(50).nullable().optional(),
  description:      z.string().min(1).max(100),
  categoryId:       z.number().int().positive(),
  financialPlansId: z.number().int().positive().nullable().optional(),
  promotion:        sn.optional().default('N'),
  highlights:       sn.optional().default('N'),
  published:        sn.optional().default('N'),
  active:           sn.optional().default('S'),
  note:             z.string().max(4000).nullable().optional(),
  prices:           z.array(priceDto).optional().default([])
                     .refine(arr => {
                       const ids = arr.map(p => p.priceListId)
                       return new Set(ids).size === ids.length
                     }, { message: 'Tabela de preço duplicada na grade' }),
})

export type ServiceDto = z.infer<typeof serviceDto>
