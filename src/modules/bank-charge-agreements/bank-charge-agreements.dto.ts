import { z } from 'zod'

/**
 * DTOs (Zod) do módulo bank-charge-agreements. Taxas em % (0–100);
 * `dayProtest` obrigatório quando `protest='S'` (o legado só usa o campo
 * nesse caso — bank-slip.ts `agreement.protest === 'S' ? dayProtest : null`).
 */

const flag = z.enum(['S', 'N'])
const percent = z.number().min(0).max(100).nullable().optional()
const money = z.number().min(0).nullable().optional()

const baseFields = {
  agreement:     z.string().min(1).max(30),
  bankAccountId: z.number().int().positive(),
  active:        flag.default('S'),
  accept:        flag.default('N'),
  aliqDiscount:  percent,
  aliqInterest:  percent,
  aliqLate:      percent,
  valueLateMin:  money,
  aliqFine:      percent,
  valueFine:     money,
  valueRate:     money,
  instruction:   z.string().max(500).nullable().optional(),
  protest:       flag.default('N'),
  dayProtest:    z.number().int().min(0).max(9999).nullable().optional(),
  ourNumberNext: z.number().int().positive().nullable().optional(),
}

export const chargeAgreementDto = z.object(baseFields).refine(
  body => body.protest !== 'S' || (body.dayProtest != null && body.dayProtest > 0),
  { message: 'Informe os dias para protesto', path: ['dayProtest'] },
)

export type ChargeAgreementDto = z.infer<typeof chargeAgreementDto>
