/**
 * Prova de aceite da A3 da F2a — LADO VELHO (companheiro de `prove-f2a-aceite.ts`): o código da ÁRVORE VIVA (setes-api main ANTES do merge
 * da janela — ainda com `@shared/invoice-transmission`) lendo a ORIGEM (tabelas fiscais do ERP). Só leitura, sem trava (`latestTransmission`
 * com forUpdate=false). Rodar com cwd NA ÁRVORE VIVA (os aliases @shared são os dela) e o node_modules dela:
 *   cd D:/Gestao2027/setes-api && NODE_PATH=./node_modules npx tsx --require tsconfig-paths/register  *     D:/Gestao2027/setes-api-f2a/scripts/prove-f2a-aceite-origem.ts <saida.json>
 * (ORIGIN_DIR = a árvore viva; padrão D:/Gestao2027/setes-api.) Depois do merge da janela este script não roda mais — é o "antes".
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
const ORIGIN = process.env.ORIGIN_DIR ?? 'D:/Gestao2027/setes-api'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pool = require(path.join(ORIGIN, 'src', 'shared', 'db', 'connection')).default
const {
  getServiceFiscalSummaries, latestTransmission, countPendingEffects, isLiveTransmission, isAuthorized,
// eslint-disable-next-line @typescript-eslint/no-var-requires
} = require(path.join(ORIGIN, 'src', 'shared', 'invoice-transmission'))

const S = 'setes_setes', INST = 1
async function main(): Promise<void> {
  const [ids] = await pool.query<any[]>(`SELECT DISTINCT tb_invoice_id AS id FROM \`${S}\`.tb_invoice_service_transmission WHERE tb_institution_id = ? AND terminal = 0 ORDER BY 1`, [INST])
  const invoiceIds = ids.map((r: any) => Number(r.id))
  const seals = await getServiceFiscalSummaries(S, INST, invoiceIds)
  const out: any[] = []
  for (const id of invoiceIds) {
    const tx = await latestTransmission(pool, S, INST, id, false)
    // a REGRA VELHA do bloco fiscal do plano (invoice-cancel.ts do main, verbatim)
    const homologationAuthorized = !!tx && isAuthorized(tx) && tx.environment === 'H'
    const blocked = !!tx && (isLiveTransmission(tx) || isAuthorized(tx)) && !homologationAuthorized
    const kind = !blocked ? 'none' : isAuthorized(tx) ? 'authorized' : tx.lastKind === 'K' ? 'cancel-in-flight' : 'in-flight'
    out.push({
      invoiceId: id, seal: seals.get(id), block: kind,
      fiscalRecord: !!tx?.accessKey && tx.environment === 'P',
      pending: (await countPendingEffects(pool, S, INST, id)) > 0,
      current: tx ? { attempt: tx.attempt, lastKind: tx.lastKind, lastCode: (tx as any).lastCode ?? null, lastSource: (tx as any).lastSource ?? null, environment: tx.environment } : null,
    })
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1))
  console.log(`velho: ${out.length} notas`)
}
main().then(() => pool.end()).catch(async e => { console.error(e); await pool.end(); process.exit(1) })
