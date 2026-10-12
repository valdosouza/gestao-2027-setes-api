/**
 * PROVA DE ACEITE da A3 da F2a (`prompt_apis_fiscais_isoladas.md` §22.3/§22.11): o leitor NOVO (esta árvore — porta `@shared/fiscal-voice`
 * sobre a RÉPLICA do fiscal_api recém-sincronizada pelo `migrate:setes`) × o leitor VELHO (o código da árvore viva antes da janela, sobre a
 * ORIGEM — as tabelas fiscais do ERP) = ZERO divergência no SELO da lista de OS, no BLOCO fiscal do plano de cancelamento, no REGISTRO
 * fiscal e na PENDÊNCIA do efeito. SOMENTE LEITURA, sem trava.
 *
 *   1. (árvore viva, ANTES do merge da janela) cd D:/Gestao2027/setes-api &&
 *        npx tsx --require tsconfig-paths/register <scratchpad>/aceite-velho.ts <saida.json>   (o lado velho — §22.11)
 *   2. cd D:/Gestao2027/nfse-api && npm run migrate:setes          (a réplica recém-sincronizada)
 *   3. (esta árvore) npx tsx --require tsconfig-paths/register scripts/prove-f2a-aceite.ts <saida.json>
 *
 * Divergência ESPERADA (e só ela): o bloco "reconfirm" — o leitor velho não lia a prova da reconferência (ele perguntava ao fisco antes do
 * cancelamento local — morreu com a D-F4); o novo EXIGE a prova lida no banco (D-F29/D-F109). Toda outra diferença = FALHA.
 * Sai com código 1 em qualquer divergência não esperada.
 */
import 'dotenv/config'
import fs from 'fs'
import pool from '../src/shared/db/connection'
import { assertSchema } from '../src/shared/db/schema'
import {
  readInvoiceLives, readInvoiceFiscal, fiscalCancelBarrier, invoiceFiscalRecord, fiscalEffectOf, readFiscalSeals,
  findCurrentCancelWaiver,
} from '../src/shared/invoice'

const S = assertSchema(process.env.PROVE_SCHEMA ?? 'setes_setes')
const INST = Number(process.env.PROVE_INSTITUTION ?? 1)

async function main(): Promise<number> {
  const old: any[] = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const ids = old.map(o => Number(o.invoiceId))
  const seals = await readFiscalSeals(pool, S, INST, ids)
  const lives = await readInvoiceLives(pool, S, INST, ids)
  let failures = 0, expected = 0
  for (const o of old) {
    const id = Number(o.invoiceId)
    const life = lives.get(id) ?? null
    const reading = await readInvoiceFiscal(pool, INST, id, life?.lifeEvent ?? null)
    const barrier = fiscalCancelBarrier(reading)
    const waiver = reading.current?.accessKey ? await findCurrentCancelWaiver(pool, S, INST, id, reading.current.accessKey) : null
    const effect = life && !life.invoiceDeleted ? fiscalEffectOf(reading.current, life.lastKind, !!waiver) : 'none'
    const n = {
      seal: seals.get(id), block: barrier.kind, fiscalRecord: invoiceFiscalRecord(reading), pending: effect !== 'none',
    }
    const diffs: string[] = []
    if (JSON.stringify(n.seal) !== JSON.stringify(o.seal)) diffs.push(`selo ${JSON.stringify(o.seal)} → ${JSON.stringify(n.seal)}`)
    if (n.fiscalRecord !== o.fiscalRecord) diffs.push(`registro ${o.fiscalRecord} → ${n.fiscalRecord}`)
    if (n.pending !== o.pending) diffs.push(`pendência ${o.pending} → ${n.pending} (efeito ${effect})`)
    let blockNote = ''
    if (n.block !== o.block) {
      if (n.block === 'reconfirm' && o.block === 'none') { expected++; blockNote = ` [ESPERADO: prova da reconferência — ${(barrier as any).reason}]` }
      else diffs.push(`bloco ${o.block} → ${n.block}`)
    }
    if (diffs.length) failures++
    console.log(`${diffs.length ? 'FALHA' : 'OK   '} nota ${id} — ${o.current ? `t${o.current.attempt} ${o.current.lastKind ?? '-'}${o.current.lastCode ? `/${o.current.lastCode}` : ''} ${o.current.environment}` : 'sem tentativa'}`
      + ` · selo ${n.seal?.state} · bloco ${n.block}${blockNote} · registro ${n.fiscalRecord} · efeito ${effect}${diffs.length ? ` — ${diffs.join('; ')}` : ''}`)
  }
  console.log(`\n${old.length} notas · ${failures} divergência(s) · ${expected} diferença(s) ESPERADA(s) (prova da reconferência)`)
  return failures
}

main()
  .then(async f => { await pool.end(); process.exit(f ? 1 : 0) })
  .catch(async err => { console.error('ERRO', err); await pool.end(); process.exit(1) })
