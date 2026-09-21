import { z } from 'zod'

/**
 * Sub-recurso CANAL API da conta (Onda 2 — D-I3/D-I4): o que é DADO do canal.
 * Segredos entram por outro DTO, write-only, e nunca voltam.
 */
export const bankChannelDto = z.object({
  environment: z.enum(['S', 'P']),
  // identificador da aplicação no banco (Inter: UUID) — só o alfabeto de um id;
  // não é caminho de arquivo (o cofre deriva o caminho dos ids da conta), mas
  // '../x' aqui era aceito e ia parar na tela (sonda ao vivo do gate, A4)
  clientId:    z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'client_id inválido')
                .nullable().optional().transform(v => v ?? null),
  active:      z.enum(['S', 'N']).default('S'),
})

/** Upload WRITE-ONLY: cada campo é opcional — o que vier é gravado, o que não vier fica. */
export const bankChannelSecretsDto = z.object({
  certificatePem: z.string().min(1).max(64_000).optional(),
  privateKeyPem:  z.string().min(1).max(64_000).optional(),
  clientSecret:   z.string().min(1).max(4_000).optional(),
}).refine(v => v.certificatePem || v.privateKeyPem || v.clientSecret, {
  message: 'Envie ao menos um dos segredos: certificatePem, privateKeyPem ou clientSecret',
})

export const bankChannelWebhookDto = z.object({
  url: z.string().url().max(500).refine(u => u.startsWith('https://'), 'A URL do webhook precisa ser https://'),
})

export type BankChannelDto = z.infer<typeof bankChannelDto>
export type BankChannelSecretsDto = z.infer<typeof bankChannelSecretsDto>
export type BankChannelWebhookDto = z.infer<typeof bankChannelWebhookDto>
