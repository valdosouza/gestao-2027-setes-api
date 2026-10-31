/**
 * D-PV16 (gate adversarial do delta, 2026-10-18): quando a conferência roda com um `.env` de DESTINO (`DOTENV_CONFIG_PATH` — o
 * `build-web.ps1` da publicação), as variáveis do banco TÊM de vir dele. Sem isto, um arquivo sem `DB_*` conferia em silêncio o banco
 * do `.env` da pasta (o `dotenv.config()` do `connection.ts` completa o que falta) e saía 0. Importado ANTES do `connection`.
 */
import fs from 'fs'
import dotenv from 'dotenv'

const target = process.env.DOTENV_CONFIG_PATH
if (target) {
  const parsed = dotenv.parse(fs.readFileSync(target))
  // DB_PASSWORD presente (pode ser vazia): sem a chave, o `.env` da pasta completaria a senha e conferiria outro banco
  const missing = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD'].filter(k => !(k in parsed))
  if (missing.length) {
    console.error(`o .env de destino (${target}) não traz ${missing.join(', ')} — a conferência não roda contra outro banco`)
    process.exit(2)
  }
}
