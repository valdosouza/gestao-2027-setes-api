// =====================================================================================================================================
// Gera a lista de senhas comuns da política de senha (D-EA5/A-EA9/D-EA36 — Onda 3 do endurecer, prompt_endurecer_autenticacao.md):
//   data/common-passwords.txt  (lida pela peça `@shared/auth/password-policy`; o boot recusa subir sem ela)
//   <setes-app>/packages/setes_validators/lib/src/common_passwords.g.dart  (a CÓPIA do app — o teste Dart confere entrada por entrada)
// Fontes: SecLists `Passwords/Common-Credentials/10k-most-common.txt` (MIT, Daniel Miessler — baixado com o "Pode baixar" do Valdo,
// Q-EA36) + `data/common-passwords-br.txt` (escrita à mão). Filtro: minúsculas, 8 a 100 caracteres (as menores já caem pelo tamanho),
// sem repetição, ordem de entrada preservada (SecLists primeiro).
// Uso: npx tsx scripts/gerar-common-passwords.ts <caminho do 10k-most-common.txt> [<pasta do setes-app>]
// =====================================================================================================================================
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, commonListKey } from '../src/shared/auth/password-policy'

const SECLISTS_SHA256 = '68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce'

/** O aviso da licença MIT do SecLists — vai INTEIRO nas duas cópias (a do app é distribuída no build web; gate socrático da Onda 3, LOW 7). */
const MIT_NOTICE = [
  'Parte desta lista vem do SecLists, sob a licença MIT:',
  '',
  'MIT License',
  '',
  'Copyright (c) 2018 Daniel Miessler',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
]

function entries(text: string): string[] {
  return text.split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(commonListKey)
}

function dartLiteral(s: string): string {
  if (!s.includes("'")) return `r'${s}'`
  if (!s.includes('"')) return `r"${s}"`
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`
}

function main() {
  const seclists = process.argv[2]
  if (!seclists) throw new Error('uso: npx tsx scripts/gerar-common-passwords.ts <10k-most-common.txt> [<setes-app>]')
  const raw = fs.readFileSync(seclists)
  const sha = createHash('sha256').update(raw).digest('hex')
  if (sha !== SECLISTS_SHA256) throw new Error(`SHA-256 do SecLists mudou (${sha}) — conferir a fonte e atualizar SECLISTS_SHA256 de propósito`)

  const root = path.resolve(__dirname, '..')
  const br = fs.readFileSync(path.join(root, 'data', 'common-passwords-br.txt'), 'utf-8')
  const seen = new Set<string>(), out: string[] = []
  for (const e of [...entries(raw.toString('utf-8')), ...entries(br)]) {
    if (e.length < PASSWORD_MIN_LENGTH || e.length > PASSWORD_MAX_LENGTH || e.trim().length === 0 || seen.has(e)) continue
    seen.add(e); out.push(e)
  }

  const header = [
    '# Senhas comuns — política de senha do setes-api (D-EA5/A-EA9/D-EA36). ARQUIVO GERADO por scripts/gerar-common-passwords.ts — não editar.',
    `# Fontes: SecLists Passwords/Common-Credentials/10k-most-common.txt (SHA-256 ${SECLISTS_SHA256})`,
    '#         + data/common-passwords-br.txt (lista brasileira escrita à mão).',
    ...MIT_NOTICE.map(l => `# ${l}`.trimEnd()),
    `# Filtro: minúsculas, ${PASSWORD_MIN_LENGTH} a ${PASSWORD_MAX_LENGTH} caracteres, sem repetição. ${out.length} entradas.`,
  ]
  const txt = [...header, ...out, ''].join('\n')
  fs.writeFileSync(path.join(root, 'data', 'common-passwords.txt'), txt, 'utf-8')
  console.log(`[common-passwords] ${out.length} entradas → data/common-passwords.txt`)

  const app = process.argv[3] ?? path.resolve(root, '..', 'setes-app')
  const dartFile = path.join(app, 'packages', 'setes_validators', 'lib', 'src', 'common_passwords.g.dart')
  if (!fs.existsSync(path.dirname(dartFile))) { console.log(`[common-passwords] setes-app não encontrado em ${app} — cópia Dart NÃO gerada`); return }
  const dart = [
    '// ARQUIVO GERADO por setes-api/scripts/gerar-common-passwords.ts — não editar. Cópia da lista de senhas comuns da API',
    '// (setes-api/data/common-passwords.txt — D-EA5/A-EA9/D-EA36); o teste `password_policy_test.dart` confere entrada por entrada.',
    '//',
    ...MIT_NOTICE.map(l => `// ${l}`.trimEnd()),
    '// ignore_for_file: lines_longer_than_80_chars',
    '',
    'const Set<String> commonPasswords = {',
    ...out.map(e => `  ${dartLiteral(e)},`),
    '};',
    '',
  ].join('\n')
  fs.writeFileSync(dartFile, dart, 'utf-8')
  console.log(`[common-passwords] cópia Dart → ${dartFile}`)
}

main()
