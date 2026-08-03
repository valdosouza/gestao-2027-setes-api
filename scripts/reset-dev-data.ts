/**
 * RESET SELETIVO da base de desenvolvimento (Valdo, 2026-07-27 — recarga
 * limpa do Sincronizador após a 1ª rodada real).
 *
 * ZERA (dados operacionais):
 *  - TODOS os schemas de cliente (setes_<nome>): TRUNCATE em todas as
 *    tabelas EXCETO as de configuração comercial/licença (whitelist abaixo)
 *    — pedidos, notas, itens, financeiro, produtos, clientes, categorias,
 *    estoque, preços, caixa, contratos/OS etc.
 *  - setes_central: vínculos de usuário criados pelo SYNC (kind='SYNC') e
 *    seus tb_user sem credencial; conflitos de sync; catálogos alimentados
 *    pelo cliente (brand/package/measure/payment_types); e TODA a cadeia de
 *    entidade (person/company/no_doc/address/phone/social_media/mailing/
 *    entity) que NÃO sustenta o sistema.
 *
 * PRESERVA (o que faz o sistema rodar):
 *  - tb_institution (estabelecimento Setes + demais cadastrados), com sua
 *    cadeia de entidade completa; tb_user reais + tb_institution_has_user;
 *    tb_sync_api_key; catálogo de UI (interface/privilege/field/config/
 *    theme/preference); referência (country/state/city, cfop/ncm/cest/tax,
 *    tb_bank); tb_feature_flag; tb_error_catalog; tb_crashlytics; _migrations.
 *  - No schema do cliente: tb_module, tb_module_has_interface,
 *    tb_institution_has_interface, tb_user_has_privilege,
 *    tb_institution_has_field, tb_institution_has_config, _migrations.
 *
 * USO:
 *   npx tsx --require tsconfig-paths/register scripts/reset-dev-data.ts        # DRY-RUN (só lista)
 *   npx tsx --require tsconfig-paths/register scripts/reset-dev-data.ts --yes  # EXECUTA
 */
import pool from '@shared/db/connection'

const EXECUTE = process.argv.includes('--yes')

// Tabelas do schema do CLIENTE que sobrevivem (configuração, não dado)
const SCHEMA_KEEP = new Set([
  '_migrations',
  'tb_module',
  'tb_module_has_interface',
  'tb_institution_has_interface',
  'tb_user_has_privilege',
  'tb_institution_has_field',
  'tb_institution_has_config',
])

async function main() {
  const conn = await pool.getConnection()
  const run = async (sql: string, params: any[] = []) => {
    if (!EXECUTE) return console.log('  [dry-run]', sql.replace(/\s+/g, ' ').trim(), params.length ? params : '')
    const [r]: any = await conn.query(sql, params)
    if (r?.affectedRows !== undefined) console.log('  ok', r.affectedRows, '→', sql.replace(/\s+/g, ' ').trim().slice(0, 90))
  }

  try {
    const [institutions] = await conn.query<any[]>(
      `SELECT id, schema_name FROM setes_central.tb_institution WHERE deleted = 'N'`)
    console.log(EXECUTE ? '=== EXECUTANDO reset ===' : '=== DRY-RUN (nada será apagado; rode com --yes para executar) ===')

    // ---- 1. Schemas de cliente: TRUNCATE em tudo que não é whitelist ----
    for (const inst of institutions) {
      const schema = inst.schema_name
      const [tables] = await conn.query<any[]>(
        `SELECT table_name AS t FROM information_schema.tables
         WHERE table_schema = ? AND table_type = 'BASE TABLE'`, [schema])
      const wipe = tables.map(r => r.t).filter((t: string) => !SCHEMA_KEEP.has(t.toLowerCase()))
      console.log(`\n-- ${schema}: ${wipe.length} tabelas zeradas, ${tables.length - wipe.length} preservadas`)
      await run('SET FOREIGN_KEY_CHECKS = 0')
      for (const t of wipe) await run(`TRUNCATE TABLE \`${schema}\`.\`${t}\``)
      await run('SET FOREIGN_KEY_CHECKS = 1')
    }

    // ---- 2. setes_central: artefatos do sync ----
    console.log('\n-- setes_central')
    await run(`DELETE FROM setes_central.tb_sync_conflict`)
    // usuários criados pelo SYNC (sem credencial) e seus vínculos
    await run(`DELETE FROM setes_central.tb_institution_has_user WHERE kind = 'SYNC'`)
    await run(`DELETE FROM setes_central.tb_user
               WHERE password IS NULL
                 AND id NOT IN (SELECT tb_user_id FROM setes_central.tb_institution_has_user)`)
    // catálogos centrais alimentados pelo cliente (vínculos já foram no passo 1)
    for (const t of ['tb_brand', 'tb_package', 'tb_measure', 'tb_payment_types']) {
      await run(`DELETE FROM setes_central.${t}`)
    }

    // ---- 3. Cadeia de entidade: mantém SÓ o que sustenta o sistema ----
    // (entidades de tb_institution e de tb_user restantes; todo o resto cai)
    await run('SET FOREIGN_KEY_CHECKS = 0')
    const keep = `SELECT id FROM setes_central.tb_institution
                  UNION SELECT id FROM setes_central.tb_user`
    for (const t of ['tb_address', 'tb_phone', 'tb_social_media', 'tb_person', 'tb_company', 'tb_no_doc']) {
      await run(`DELETE FROM setes_central.${t} WHERE id NOT IN (${keep})`)
    }
    await run(`DELETE FROM setes_central.tb_entity_has_mailing WHERE tb_entity_id NOT IN (${keep})`)
    await run(`DELETE FROM setes_central.tb_mailing
               WHERE id NOT IN (SELECT tb_mailing_id FROM setes_central.tb_entity_has_mailing)`)
    await run(`DELETE FROM setes_central.tb_entity WHERE id NOT IN (${keep})`)
    await run('SET FOREIGN_KEY_CHECKS = 1')

    // ---- resumo ----
    if (EXECUTE) {
      const [[ent]]: any = await conn.query(`SELECT COUNT(*) n FROM setes_central.tb_entity`)
      const [[usr]]: any = await conn.query(`SELECT COUNT(*) n FROM setes_central.tb_user`)
      console.log(`\nRestaram: ${ent.n} entidades e ${usr.n} usuários na central. Sistema preservado.`)
      console.log('Lembrete: no Firebird, libere a fila para a recarga:')
      console.log("  UPDATE TB_SINCRONIA SET SRC_LOG = NULL;  (ou aguarde o catch-up por LAST_UPDATE)")
    }
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
