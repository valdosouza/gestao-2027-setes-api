// =====================================================================
// SMOKE da Onda 2 — boleto × Banco Inter no SANDBOX, pela API real (HTTP).
// Prova os critérios de sucesso 1, 2 e 4 do prompt_onda2_banco_inter.md sem
// dinheiro real: canal da conta → registro → consulta (linha digitável/pix) →
// pagamento simulado → RECEBIDO → liquidação automática (L, source A).
//
// Pré-requisitos (D-I16 — o Valdo coloca, o script só lê a PRESENÇA):
//   - conta bancária do banco 077 (Inter) no schema (o script cria se faltar);
//   - segredos em <SECRETS_PATH>/<schema>/bank-account/<id>/S/client.crt|client.key|client_secret
//     OU as variáveis INTER_CERT_PATH / INTER_KEY_PATH / INTER_CLIENT_SECRET (enviadas
//     pela API write-only, nunca impressas);
//   - INTER_CLIENT_ID no ambiente (ou já gravado no canal).
// Uso: npx tsx --require tsconfig-paths/register scripts/smoke-inter-sandbox.ts
//      [--api=http://localhost:3000] [--schema=setes_setes] [--institution=1] [--account=<id>]
// NUNCA roda contra produção (environment do canal tem que ser S).
// =====================================================================
import dotenv from 'dotenv'
dotenv.config()
import fs from 'fs'
import jwt from 'jsonwebtoken'
import pool from '@shared/db/connection'

const arg = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1]
const BASE   = (arg('api') ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '') + '/api'
const SCHEMA = arg('schema') ?? 'setes_setes'
const INST   = Number(arg('institution') ?? 1)

// Mesmo mecanismo da trilha: JWT assinado com o JWT_SECRET do .env (dev), sem senha no ambiente.
const USER = Number(arg('user') ?? 1)
const TOKEN: string = jwt.sign({ institutionId: INST, userId: USER, role: 'super', schemaName: SCHEMA },
  process.env.JWT_SECRET!, { expiresIn: '1h' })
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: any = null
  try { json = await res.json() } catch { /* sem corpo */ }
  return { status: res.status, body: json }
}
// Janela do sandbox do Inter (cadastro do Valdo em developers.inter.co, 2026-09-20): o
// ambiente de testes só responde das 8h às 20h, de SEGUNDA a SEXTA (horário de Brasília).
// Fora disso toda chamada cai em BANK_UNAVAILABLE — avisar antes de confundir com defeito.
function sandboxWindowWarning(now = new Date()): string | null {
  const dow = now.getDay(), h = now.getHours()
  if (dow === 0 || dow === 6) return `hoje é ${dow === 0 ? 'domingo' : 'sábado'}`
  if (h < 8 || h >= 20) return `são ${String(h).padStart(2, '0')}h${String(now.getMinutes()).padStart(2, '0')}`
  return null
}
const fora = sandboxWindowWarning()
if (fora) console.log(`[ AVISO ] sandbox do Inter só atende seg–sex 8h–20h — ${fora}; espere BANK_UNAVAILABLE`)

const step = (id: string, ok: boolean | 'skip', detail: string) =>
  console.log(`[${ok === 'skip' ? ' SKIP ' : ok ? '  OK  ' : ' FALHA'}] ${id.padEnd(6)} ${detail}`)
const motivo = (r: any) => `${r.status} ${r.body?.code ?? ''} ${r.body?.error ?? ''}`.trim()

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') { console.error('smoke NÃO roda em produção'); process.exit(2) }
  console.log(`\nSMOKE ONDA 2 — Inter SANDBOX · ${BASE} · schema ${SCHEMA} · institution ${INST}\n`)

  // 1. conta do banco 077
  const [[inter]] = await pool.query<any[]>(`SELECT id FROM setes_central.tb_bank WHERE number = '077' AND deleted = 'N'`)
  if (!inter) { step('C1', false, 'banco 077 (Inter) ausente do catálogo central tb_bank'); return }
  let accountId = arg('account') ? Number(arg('account')) : null
  if (!accountId) {
    const [rows] = await pool.query<any[]>(
      `SELECT id FROM \`${SCHEMA}\`.tb_bank_account WHERE tb_institution_id = ? AND tb_bank_id = ? AND deleted = 'N' ORDER BY id LIMIT 1`, [INST, inter.id])
    accountId = rows[0]?.id ? Number(rows[0].id) : null
  }
  if (!accountId) {
    const r = await api('POST', '/bank-accounts', { bankId: Number(inter.id), agency: '0001', agencyDv: null, number: process.env.INTER_ACCOUNT ?? '00000000', numberDv: process.env.INTER_ACCOUNT_DV ?? null })
    if (r.status !== 201) { step('C1', false, `criar conta Inter: ${motivo(r)}`); return }
    accountId = Number(r.body.data.id)
  }
  step('C1', true, `conta bancária ${accountId} (banco 077)`)

  // 2. canal (sandbox) + segredos
  const clientId = process.env.INTER_CLIENT_ID
  const ch0 = await api('GET', `/bank-accounts/${accountId}/channel`)
  if (!ch0.body?.data?.channel || (clientId && ch0.body.data.channel.clientId !== clientId)) {
    const r = await api('PUT', `/bank-accounts/${accountId}/channel`, { environment: 'S', clientId: clientId ?? ch0.body?.data?.channel?.clientId ?? null, active: 'S' })
    if (r.status !== 200) { step('C2', false, `canal: ${motivo(r)}`); return }
  }
  if (process.env.INTER_CERT_PATH || process.env.INTER_KEY_PATH || process.env.INTER_CLIENT_SECRET) {
    const body: any = {}
    if (process.env.INTER_CERT_PATH) body.certificatePem = fs.readFileSync(process.env.INTER_CERT_PATH, 'utf8')
    if (process.env.INTER_KEY_PATH)  body.privateKeyPem  = fs.readFileSync(process.env.INTER_KEY_PATH, 'utf8')
    if (process.env.INTER_CLIENT_SECRET) body.clientSecret = process.env.INTER_CLIENT_SECRET
    const r = await api('PUT', `/bank-accounts/${accountId}/channel/secrets`, body)
    if (r.status !== 200) { step('C2', false, `segredos: ${motivo(r)}`); return }
  }
  const ch = await api('GET', `/bank-accounts/${accountId}/channel`)
  const sec = ch.body?.data?.secrets
  const pronto = sec?.certificate && sec?.privateKey && sec?.clientSecret && ch.body?.data?.channel?.clientId
  step('C2', !!pronto, pronto
    ? `canal S · client_id ok · cert até ${sec.certificateInfo?.notAfter?.slice(0, 10)} (${sec.certificateInfo?.daysToExpire} dias)`
    : `faltam: ${[!sec?.certificate && 'certificado', !sec?.privateKey && 'chave', !sec?.clientSecret && 'client_secret', !ch.body?.data?.channel?.clientId && 'client_id'].filter(Boolean).join(', ')} — D-I16: coloque em ${process.env.SECRETS_PATH ?? './secrets'} ou passe INTER_*`)
  if (!pronto) return

  // 3. prova de vida
  const t = await api('POST', `/bank-accounts/${accountId}/channel/test`)
  step('C3', t.status === 200, t.status === 200 ? `token + mTLS ok · webhook no banco: ${t.body.data.webhook?.url ?? 'nenhum'}` : motivo(t))
  if (t.status !== 200) return

  // 4. carteira da conta Inter + boleto de um título aberto
  const ags = await api('GET', '/bank-charge-agreements')   // o lookup /bank-slips/agreements não traz bankAccountId
  let agreement = (ags.body?.data ?? []).find((a: any) => Number(a.bankAccountId) === accountId)
  if (!agreement) {
    const r = await api('POST', '/bank-charge-agreements', { bankAccountId: accountId, agreement: 'INTER-SANDBOX', active: 'S', ourNumberNext: null })
    if (r.status !== 201) { step('C4', false, `carteira: ${motivo(r)}`); return }
    agreement = { id: r.body.data.id }
  }
  const titles = await api('GET', '/bank-slips/open-titles')
  const title = (titles.body?.data ?? [])[0]
  if (!title) { step('C4', false, 'nenhum título aberto sem boleto — rode a trilha antes'); return }
  // vencimento SEMPRE futuro: o banco recusa dataVencimento < hoje (400) e o título do dev pode estar vencido há anos
  const due = new Date(Date.now() + 30 * 86_400_000); const dueIso = [due.getFullYear(), String(due.getMonth() + 1).padStart(2, '0'), String(due.getDate()).padStart(2, '0')].join('-')
  const issued = await api('POST', '/bank-slips', { agreementId: Number(agreement.id), dtExpiration: dueIso, titles: [{ orderId: title.orderId, parcel: title.parcel }] })
  if (issued.status !== 201) { step('C4', false, `emitir boleto: ${motivo(issued)}`); return }
  const slipId = Number(issued.body.data.slipId ?? issued.body.data.id)
  step('C4', true, `boleto ${slipId} emitido aqui (título ${title.orderId}/${title.parcel}) pela carteira ${agreement.id}`)

  // 5. registrar no banco (critério 1)
  const reg = await api('POST', `/bank-slips/${slipId}/register`)
  step('C5', reg.status === 201, reg.status === 201 ? `apresentação ${reg.body.data.attempt} · codigoSolicitacao ${reg.body.data.requestCode}` : motivo(reg))
  if (reg.status !== 201) return

  // 6. consulta até sair de EM_PROCESSAMENTO (até 6 × 5 s — rate limit 10/min)
  let last: any = null
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5000))
    last = await api('POST', `/bank-slips/${slipId}/refresh`)
    if (last.body?.data?.bankStatus && last.body.data.bankStatus !== 'EM_PROCESSAMENTO') break
  }
  const det = await api('GET', `/bank-slips/${slipId}`)
  const r1 = det.body?.data?.registrations?.at(-1)
  step('C6', last?.status === 200 && !!r1?.digitableLine, last?.status === 200
    ? `situação ${last.body.data.bankStatus} · linha digitável ${r1?.digitableLine ? 'ok' : 'ainda não'} · pix ${r1?.pixCopyPaste ? 'ok' : 'não'}` : motivo(last))

  // 7. pagamento simulado (critério 2) → RECEBIDO → L source A
  const pay = await api('POST', `/bank-slips/${slipId}/pay-sandbox`, { via: 'BOLETO' })
  if (pay.status !== 200) { step('C7', false, `pagamento simulado: ${motivo(pay)}`); return }
  // o sandbox processa o pagamento de forma ASSÍNCRONA (~20 s): poll com folga do rate limit (10/min)
  let fin = pay
  for (let i = 0; i < 8 && (fin.body?.data?.bankStatus !== 'RECEBIDO'); i++) {
    await new Promise(r => setTimeout(r, 6000))
    fin = await api('POST', `/bank-slips/${slipId}/refresh`)
  }
  const det2 = await api('GET', `/bank-slips/${slipId}`)
  const settled = det2.body?.data?.state === 'settled'
  const lEvent = (det2.body?.data?.events ?? []).find((e: any) => e.kind === 'L')
  step('C7', settled && lEvent?.source === 'A', settled
    ? `RECEBIDO → boleto liquidado (evento L source ${lEvent?.source}, ${lEvent?.paidValue})` : `situação ${fin.body?.data?.bankStatus ?? motivo(fin)} · estado ${det2.body?.data?.state}`)

  // 8. idempotência: consultar de novo não gera evento
  const again = await api('POST', `/bank-slips/${slipId}/refresh`)
  step('C8', again.status === 200 && again.body.data.changed === false, `2ª consulta igual: changed=${again.body?.data?.changed}`)

  // 9. PDF oficial
  const pdf = await api('GET', `/bank-slips/${slipId}/pdf`)
  step('C9', pdf.status === 200 && String(pdf.body?.data?.pdfBase64 ?? '').length > 100, pdf.status === 200 ? `PDF ${Math.round(String(pdf.body.data.pdfBase64).length * 3 / 4 / 1024)} KB` : motivo(pdf))

  console.log(`\nCriado pelo smoke (conferir/limpar): conta ${accountId}, carteira ${agreement.id}, boleto ${slipId}`)
}

main().catch(e => { console.error('SMOKE FALHOU:', e.message ?? e); process.exit(1) }).finally(() => pool.end())
