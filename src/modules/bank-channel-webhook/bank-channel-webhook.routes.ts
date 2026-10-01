import { runWithOperationClock } from '@shared/time-zone'
import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import logger from '@shared/logger/logger'
import { findBankChannelByInboundToken } from '@shared/bank-channel'
import { handleWebhookItems } from '@shared/bank-slip-registration'

/**
 * WEBHOOK do banco — rota PÚBLICA (sem JWT), montada em app.ts como
 * `/hooks/bank-channel/:institutionId/:token` ANTES do authMiddleware, com o
 * rate limit por IP (exceção nomeada, como `/auth` — ver ARQUITETURA_MODULOS_API).
 *
 * D-I9/D-I15: o webhook é GATILHO, nunca verdade. Quem chama só prova que
 * conhece o token do canal; o payload só diz QUAIS cobranças mudaram
 * (`codigoSolicitacao`); o estado vem da CONSULTA autenticada por mTLS. Um
 * webhook forjado no máximo provoca consultas.
 *
 * Responde 200 assim que identifica o canal e enfileira (o Inter reenvia até 4×
 * em não-2xx — e o que reenvia é o gatilho, então perder um é barato). Token
 * desconhecido → 404 sem distinguir "institution não existe" de "token errado".
 */

/**
 * Teto de códigos aceitos por chamada (MED-5 do gate): o corpo vai até os 2 MB do
 * express.json — sem teto, quem tiver o token faria a API queimar a cota do Inter
 * contra si mesma. O banco manda lotes pequenos; o excedente é ignorado (a consulta
 * ativa alcança o que ficou de fora). 50 = teto do próprio reenvio do Inter; com a fila
 * serial por institution, o pior caso (50 × 15 s) fica em ~12 min, não 25.
 */
export const MAX_WEBHOOK_CODES = 50

export function extractRequestCodes(body: unknown): string[] {
  const items = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : []
  const codes: string[] = []
  for (const it of items) {
    const c = (it as any)?.codigoSolicitacao ?? (it as any)?.requestCode
    if (typeof c === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(c)) codes.push(c)
    if (codes.length >= MAX_WEBHOOK_CODES) break
  }
  return codes
}

/**
 * Processamento SERIAL por institution (MED-5): cada chamada aceita já disparava um
 * processador em paralelo — 300 chamadas/min = 300 consultas mTLS e 300 conexões do
 * pool ao mesmo tempo. Uma fila em memória por institution basta nesta onda (uma
 * instância; a Onda 4 decide fila compartilhada e trust proxy — Q-I6).
 */
const queues = new Map<number, Promise<unknown>>()
function enqueue(institutionId: number, task: () => Promise<unknown>): Promise<unknown> {
  const prev = queues.get(institutionId) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(task)
  queues.set(institutionId, next)
  next.finally(() => { if (queues.get(institutionId) === next) queues.delete(institutionId) }).catch(() => undefined)
  return next
}

async function institutionSchema(institutionId: number): Promise<string | null> {
  if (!Number.isInteger(institutionId) || institutionId <= 0) return null
  const [rows] = await pool.query<any[]>(
    `SELECT schema_name AS schemaName FROM setes_central.tb_institution WHERE id = ? AND active = 'S' AND deleted = 'N'`,
    [institutionId]
  )
  return rows[0]?.schemaName ?? null
}

/** Injeção para testes: substitui o processamento assíncrono. */
let processor: (schemaName: string, institutionId: number, codes: string[]) => Promise<unknown> = handleWebhookItems
export function setWebhookProcessor(fn: typeof processor | null): void { processor = fn ?? handleWebhookItems }

export async function receive(req: Request, res: Response): Promise<void> {
  const institutionId = Number(req.params.institutionId)
  const token = String(req.params.token ?? '')
  try {
    const schemaName = await institutionSchema(institutionId)
    const channel = schemaName ? await findBankChannelByInboundToken(schemaName, token) : null
    if (!schemaName || !channel || channel.active !== 'S') {
      res.status(404).json({ error: 'Não encontrado', code: 'NOT_FOUND' })
      return
    }
    const codes = extractRequestCodes(req.body)
    res.json({ ok: true, received: codes.length })
    if (codes.length === 0) return
    // Q-TZ9: o item roda no relógio de QUANDO é processado (a fila pode atrasar na virada do dia)
    void enqueue(institutionId, () => runWithOperationClock(new Date(), () =>
      processor(schemaName, institutionId, codes)
        .then(r => logger.info('Webhook do banco processado', { institutionId, bankAccountId: channel.bankAccountId, ...(r as object) }))
        .catch(err => logger.error('Webhook do banco falhou no processamento', { institutionId, err }))))
  } catch (err) {
    logger.error('Webhook do banco: erro ao receber', { institutionId, err })
    if (!res.headersSent) res.status(500).json({ error: 'Erro interno', code: 'INTERNAL' })
  }
}

const router = Router()

/**
 * @swagger
 * /hooks/bank-channel/{institutionId}/{token}:
 *   post:
 *     tags: [BankChannel]
 *     summary: Webhook do banco (callback de cobranças) — público, autenticado pelo token do canal
 *     description: |
 *       Onda 2 da fase Primeiro Cliente (D-I9/D-I15). O banco chama esta URL quando
 *       uma cobrança muda de situação. O payload é o callback do banco (array de
 *       `{codigoSolicitacao, seuNumero, situacao, ...}`); **só o `codigoSolicitacao`
 *       é usado** — cada apresentação identificada é reconsultada no banco por mTLS
 *       e a voz do banco é gravada com `source='W'`. Responde 200 imediatamente.
 *       Token desconhecido/canal inativo → 404. Sem JWT (exceção nomeada). URL
 *       pública só existe na Onda 4 (D33); até lá a consulta ativa faz o papel.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: institutionId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: array, items: { type: object } }
 *     responses:
 *       200: { description: '{ ok, received }' }
 *       404: { description: 'Canal não identificado' }
 */
router.post('/:institutionId/:token', receive)

export default router
