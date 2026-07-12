// =====================================================================
// Gera o seed de tb_interface_has_field a partir das tabelas reais
// (information_schema) — framework de campos configuráveis.
//
// Interface ≠ tabela: uma interface pode reunir campos de VÁRIAS tabelas;
// o refino (kind/required/exclusões) é revisado MANUALMENTE no .sql gerado
// antes de aplicar (skill database/revisar-ddl.md).
//
// Uso (na pasta setes-api):
//   npm run fields:gen -- --interface 3 --tables tb_country
//   npm run fields:gen -- --interface 9 --tables tb_entity,tb_person,tb_company --out D:\tmp\x.sql
//   npm run fields:gen -- --interface 3 --tables tb_country --apply   (INSERT IGNORE direto)
//
// Regras aplicadas:
//   - schema default das tabelas: setes_central (aceita schema.tabela)
//   - colunas de auditoria (created_at, updated_at, deleted) ficam FORA
//   - kind: char(1)→Boolean | texto→String | inteiros→Integer |
//           decimal/float/double→Float | datas→Date
//   - required baseline técnico: IS_NULLABLE='NO' → 'S' (campo travado no painel)
//   - PK composta (tb_interface_id, field_name): nome repetido em 2 tabelas
//     (ex.: id da cadeia fiscal) entra só na 1ª — as demais viram aviso
// =====================================================================
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

const DEFAULT_SCHEMA = 'setes_central'
const AUDIT_COLUMNS = new Set(['created_at', 'updated_at', 'deleted'])

interface FieldRow {
  fieldName: string
  tableName: string
  kind: string
  required: 'S' | 'N'
}

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const interfaceId = Number(get('--interface'))
  const tables = (get('--tables') ?? '').split(',').map(t => t.trim()).filter(Boolean)
  const out = get('--out')
  const apply = argv.includes('--apply')
  if (!Number.isInteger(interfaceId) || interfaceId <= 0 || tables.length === 0) {
    console.error('Uso: npm run fields:gen -- --interface <id> --tables <t1,t2,...> [--out <arquivo.sql>] [--apply]')
    process.exit(1)
  }
  return { interfaceId, tables, out, apply }
}

/** char(1) é flag 'S'/'N' na casa (PADROES_BANCO §3) → Boolean. */
function mapKind(dataType: string, columnType: string): string {
  const dt = dataType.toLowerCase()
  if (dt === 'char' && /char\(1\)/i.test(columnType)) return 'Boolean'
  if (['char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum', 'set'].includes(dt)) return 'String'
  if (['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].includes(dt)) return 'Integer'
  if (['decimal', 'float', 'double'].includes(dt)) return 'Float'
  if (['date', 'datetime', 'timestamp', 'time', 'year'].includes(dt)) return 'Date'
  return 'String'
}

async function main() {
  const { interfaceId, tables, out, apply } = parseArgs(process.argv.slice(2))

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    charset: 'utf8mb4',
  })

  try {
    // Descrição da interface para o cabeçalho (aviso se não existir ainda)
    let interfaceLabel = `interface ${interfaceId}`
    const [ifaceRows] = await conn.query<any[]>(
      `SELECT description FROM ${DEFAULT_SCHEMA}.tb_interface WHERE id = ? AND deleted = 'N'`,
      [interfaceId]
    )
    if (ifaceRows.length === 0) {
      console.warn(`[fields] AVISO: tb_interface.id=${interfaceId} não encontrado em ${DEFAULT_SCHEMA} — conferir o id antes de aplicar.`)
    } else {
      interfaceLabel = `interface ${interfaceId} (${ifaceRows[0].description})`
    }

    const fields: FieldRow[] = []
    const seen = new Map<string, string>() // field_name → tabela que o registrou

    for (const spec of tables) {
      const [schema, table] = spec.includes('.') ? spec.split('.') : [DEFAULT_SCHEMA, spec]
      const [cols] = await conn.query<any[]>(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE
           FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ?
          ORDER BY ORDINAL_POSITION`,
        [schema, table]
      )
      if (cols.length === 0) throw new Error(`Tabela não encontrada: ${schema}.${table}`)

      for (const col of cols) {
        const name = String(col.COLUMN_NAME)
        if (AUDIT_COLUMNS.has(name)) continue
        const owner = seen.get(name)
        if (owner) {
          console.warn(`[fields] PULADO ${table}.${name} — já registrado por ${owner} (PK composta interface+campo)`)
          continue
        }
        seen.set(name, table)
        fields.push({
          fieldName: name,
          tableName: table,
          kind: mapKind(String(col.DATA_TYPE), String(col.COLUMN_TYPE)),
          required: col.IS_NULLABLE === 'NO' ? 'S' : 'N',
        })
      }
      console.log(`[fields] ${schema}.${table}: ${cols.length} colunas lidas`)
    }

    if (fields.length === 0) throw new Error('Nenhum campo restou após os filtros.')

    const values = fields
      .map(f => `  (${interfaceId}, '${f.fieldName}', '${f.tableName}', '${f.kind}', '${f.required}', NOW(), NOW(), 'N')`)
      .join(',\n')

    const sql = `-- =====================================================================
-- Seed de tb_interface_has_field — ${interfaceLabel}
-- Gerado por setes-api/scripts/gerar-interface-fields.ts em ${new Date().toISOString().slice(0, 10)}
-- Tabelas de origem: ${tables.join(', ')}
-- REVISAR MANUALMENTE antes de aplicar: kind, required (baseline técnico
-- 'S' = travado no painel do cliente) e campos que não devem aparecer.
-- Re-executável: INSERT IGNORE preserva linhas já editadas na base.
-- =====================================================================
USE \`${DEFAULT_SCHEMA}\`;

INSERT IGNORE INTO \`tb_interface_has_field\`
  (\`tb_interface_id\`, \`field_name\`, \`table_name\`, \`kind\`, \`required\`, \`created_at\`, \`updated_at\`, \`deleted\`)
VALUES
${values};
`

    if (apply) {
      await conn.query(sql.replace(/^USE .*;$/m, '').replace(/^--.*$/gm, ''))
      console.log(`[fields] APLICADO: ${fields.length} campos da ${interfaceLabel} em ${DEFAULT_SCHEMA}.tb_interface_has_field`)
    }

    const outPath = out ?? path.resolve(__dirname, '..', '..', 'sql', `seed_interface_${interfaceId}_fields.sql`)
    fs.writeFileSync(outPath, sql, 'utf-8')
    console.log(`[fields] Seed gerado (${fields.length} campos): ${outPath}`)
    if (!apply) console.log('[fields] Revise o arquivo e aplique via mysql ou rode novamente com --apply.')
  } finally {
    await conn.end()
  }
}

main().catch(err => {
  console.error('[fields] FALHA:', err.message ?? err)
  process.exit(1)
})
