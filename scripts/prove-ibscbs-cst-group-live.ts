/**
 * PROVA AO VIVO da D-IB113 (fase IBS/CBS) contra uma CÓPIA do catálogo central num SCHEMA DESCARTÁVEL — o MariaDB real e a fonte
 * oficial real, sem tocar o `setes_central`:
 *   1. copia as 7 tabelas do catálogo IBS/CBS vivo (CREATE TABLE … LIKE + as linhas — só LEITURA da origem) e aplica o script 73;
 *   2. roda a CARGA REAL (`applyCatalog` com o IT oficial lido pelo `parseItCatalog`) e a PEÇA de classificação apontadas para a
 *      cópia (o SQL delas fixa `setes_central.` — a conexão da prova o troca pelo schema descartável);
 *   3. confere: indicador gravado = aba CST do IT; `cstGroupOff` da 1ª carga = os CSTs sem o grupo; veredito, lista de apoio, 422
 *      do cadastro e declaração do faturamento (antes × depois da obrigação) pelo MESMO motivo; 2ª carga inalterada;
 *   4. (com --calculadora) confere o ind_gIBSCBS do IT contra o `exigeGrupoIbsCbs` da Calculadora oficial para TODO cClassTrib
 *      aceito na NFS-e hoje (o que a conferência D-IB28 (a) da carga faz — aqui só lê).
 * Apaga o schema descartável no fim (inclusive em falha).
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-ibscbs-cst-group-live.ts [--it <xlsx>] [--sql <pasta>] [--calculadora]
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import { readXlsx } from '@shared/xlsx/read-xlsx'
import { todayIn, DEFAULT_TIME_ZONE } from '@shared/time-zone'
import { applyCatalog, parseCalculatorPair, parseItCatalog, CALCULATOR_NFSE_SIGLA } from '@shared/ibscbs-catalog'
import {
  MODEL_NFSE, Queryable, assertServiceClassification, classificationVerdictsAt, deriveCst, evaluateIbscbsDeclaration,
  listClassificationsLookup,
} from '@shared/ibscbs-classification'

const argv = process.argv.slice(2)
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const firstExisting = (...candidates: string[]) => candidates.find(c => fs.existsSync(c)) ?? candidates[0]
const IT_FILE = path.resolve(opt('--it') ?? firstExisting(
  ...['../../Infra-IA', '../../../Infra-IA'].map(r => path.join(__dirname, r,
    'setes-api/integracoes/nfse-adn/classificacao-ibs-cbs/it-2025-002-v1-70-cclasstrib.xlsx'))))
const SQL_DIR = path.resolve(opt('--sql') ?? path.join(__dirname, '..', '..', 'sql'))
const PROBE = `setes_ib113_live_${process.pid}`
const TABLES = ['tb_tax_ibscbs', 'tb_tax_ibscbs_classification', 'tb_tax_ibscbs_classification_validity',
  'tb_tax_ibscbs_classification_applicability', 'tb_ibscbs_place_indicator', 'tb_ibscbs_place_indicator_applicability', 'tb_nbs']
const CALCULATOR = 'https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/api/calculadora'

async function main() {
  const raw = await pool.getConnection()
  // a peça e a carga fixam `setes_central.` no SQL — aqui ele aponta para a cópia descartável (nunca para o vivo)
  const rewrite = (sql: string) => sql.split('setes_central.').join(`\`${PROBE}\`.`)
  const conn: any = {
    query: (sql: string, params?: unknown[]) => raw.query(rewrite(sql), params),
    beginTransaction: () => raw.beginTransaction(), commit: () => raw.commit(), rollback: () => raw.rollback(),
  }
  const q: Queryable = conn
  let ok = true
  const check = (label: string, cond: boolean) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${label}`); ok &&= cond }
  const today = todayIn(DEFAULT_TIME_ZONE)   // o mesmo "hoje" da rotina do Super (load-ibscbs-catalog.ts)
  try {
    await raw.query(`CREATE DATABASE \`${PROBE}\``)
    for (const t of TABLES) {
      await raw.query(`CREATE TABLE \`${PROBE}\`.${t} LIKE setes_central.${t}`)
      await raw.query(`INSERT INTO \`${PROBE}\`.${t} SELECT * FROM setes_central.${t}`)
    }
    await raw.query(`USE \`${PROBE}\``)
    for (const st of splitStatements(fs.readFileSync(path.join(SQL_DIR, '73_ibscbs_cst_requires_group.sql'), 'utf8'))) {
      if (!/^USE\s/i.test(st.trim())) await raw.query(st)
    }
    check(`cópia do catálogo vivo (${TABLES.length} tabelas) + script 73 no schema descartável`, true)

    const it = parseItCatalog(readXlsx(fs.readFileSync(IT_FILE)))
    const sourceOff = it.csts.filter(c => !c.requiresGroup).map(c => c.id).sort()
    console.log(`     IT: ${it.csts.length} CST — sem o grupo: ${sourceOff.join(', ')}`)

    const r1 = await applyCatalog(conn, { it, itVersion: 'IT 2025.002 v1.70', unconfirmed: [], models: ['SE'], apply: true, allowShrink: true })
    const [stored] = await raw.query<any[]>(`SELECT id, requires_ibscbs_group AS g FROM tb_tax_ibscbs ORDER BY id`)
    const want = new Map(it.csts.map(c => [c.id, c.requiresGroup ? 'S' : 'N']))
    check(`1ª carga grava o indicador do IT em todo CST (${(stored as any[]).map(r => `${r.id}=${r.g}`).join(' ')})`,
      (stored as any[]).every(r => r.g === want.get(r.id)))
    check(`1ª carga (NULL → indicador): cstGroupOff = os CSTs sem o grupo (${r1.cstGroupOff.join(', ')})`,
      JSON.stringify([...r1.cstGroupOff].sort()) === JSON.stringify(sourceOff))
    const r2 = await applyCatalog(conn, { it, itVersion: 'IT 2025.002 v1.70', unconfirmed: [], models: ['SE'], apply: true, allowShrink: true })
    check(`2ª carga: CST inalterado (${JSON.stringify(r2.cst)}), nada a avisar`, r2.cst.unchanged === it.csts.length && r2.cstGroupOff.length === 0)

    // cClassTrib aceitos na NFS-e HOJE antes da regra (presença + sem tributação regular) — a D-IB113 recusa só os de CST sem o grupo
    const [cand] = await raw.query<any[]>(
      `SELECT DISTINCT v.code FROM tb_tax_ibscbs_classification_validity v
         JOIN tb_tax_ibscbs_classification_applicability a ON a.code = v.code AND a.valid_from = v.valid_from AND a.model = 'SE' AND a.deleted = 'N'
        WHERE v.deleted = 'N' AND v.absent_since_version IS NULL AND v.requires_regular_taxation = 'N'
          AND v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until >= ?) ORDER BY v.code`, [today, today])
    const codes = (cand as any[]).map(r => String(r.code))
    const verdicts = await classificationVerdictsAt(q, codes, MODEL_NFSE, today)
    const refused = codes.filter(c => !verdicts.get(c)!.accepted)
    const offSet = new Set(sourceOff)
    check(`veredito hoje: ${codes.length - refused.length} aceitos × ${refused.length} recusados — recusado ⇔ CST sem o grupo, motivo cst-without-group`,
      codes.every(c => (verdicts.get(c)!.reason === 'cst-without-group') === offSet.has(deriveCst(c)))
      && refused.every(c => verdicts.get(c)!.reason === 'cst-without-group'))
    check('000001 (a Setes) segue aceito', verdicts.get('000001')?.accepted === true)

    const lookup = (await listClassificationsLookup('', today, MODEL_NFSE, q)).map(r => r.code)
    check(`lista de apoio: ${lookup.length} códigos, nenhum de CST sem o grupo; 000001 presente`,
      lookup.includes('000001') && lookup.every(c => !offSet.has(deriveCst(c))))

    const victim = refused[0]
    check(`há código real para atacar (${victim})`, !!victim)
    const e: any = await assertServiceClassification(q, { ibscbs: { classificationCode: victim, placeIndicatorCode: '100301' } }, today)
      .then(() => null, (err: any) => err)
    check(`cadastro: salvar ${victim} = 422 ${e?.code} em ${e?.fields?.[0]?.field}`,
      e?.statusCode === 422 && e?.code === 'IBSCBS_CLASSIFICATION_GROUP_UNSUPPORTED' && e?.fields?.[0]?.field === 'ibscbs.classificationCode')
    await assertServiceClassification(q, { ibscbs: { classificationCode: '000001', placeIndicatorCode: '100301' } }, today)
    check('cadastro: 000001 + 100301 passa', true)

    const sv = { productId: 1, description: 'Serviço de prova', field: 'product.1', nbs: '115021000', classificationCode: victim, placeIndicatorCode: '100301' }
    const before = await evaluateIbscbsDeclaration(q, [sv], '2026-12-20', '2027-01-01')
    check(`faturamento antes da obrigação: grupo omitido (${before.declaration.omitted.join(', ')}), sem recusa`,
      before.declaration.group === null && before.declaration.omitted.includes('cst-without-group') && before.refusal === null)
    const after = await evaluateIbscbsDeclaration(q, [sv], '2027-01-05', '2027-01-01')
    check(`faturamento depois da obrigação: 422 ${after.refusal?.code} — "${after.refusal?.message.slice(0, 110)}…"`,
      after.refusal?.code === 'INVOICE_SERVICE_IBSCBS_REQUIRED' && /não leva o grupo IBS\/CBS/.test(after.refusal?.message ?? ''))

    if (argv.includes('--calculadora')) {
      // a Calculadora é a voz que o fisco consulta (E0961) — todo código aceito na NFS-e hoje pela presença, um par por vez
      const diverge: string[] = []
      for (const code of codes) {
        await new Promise(res => setTimeout(res, 250))
        const res = await fetch(`${CALCULATOR}/dados-abertos/classificacoes-tributarias/cbs-ibs/${CALCULATOR_NFSE_SIGLA}/${code}?data=${today}`,
          { headers: { Accept: 'application/json', Connection: 'close' }, signal: AbortSignal.timeout(30_000) })
        if (!res.ok) { diverge.push(`${code}: HTTP ${res.status}`); continue }
        const pair = parseCalculatorPair(await res.json(), code, today)
        if (pair.requiresGroup !== (want.get(deriveCst(code)) === 'S')) diverge.push(`${code}: IT ${want.get(deriveCst(code))} × Calculadora ${pair.requiresGroup}`)
      }
      check(`Calculadora × IT no grupo IBS/CBS: ${codes.length} pares, ${diverge.length} divergência(s) ${diverge.join('; ')}`, diverge.length === 0)
    }
  } finally {
    await raw.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    raw.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA AO VIVO OK — schema descartável apagado' : '\nPROVA AO VIVO FALHOU — schema descartável apagado')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('FALHA', e?.stack ?? e?.message ?? e); process.exit(1) })
