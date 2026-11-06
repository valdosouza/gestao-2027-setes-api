/// <reference types="jest" />
// D-F221…D-F225 (2026-11-05 — prompt_apis_fiscais_isoladas.md §23) + gate socrático do DEPLOY.E1.P1, achado 1 (HIGH): o núcleo entra
// SÓ pelo pacote em `vendor/`. CONHECIMENTO NEGATIVO: com o cache do npm já cheio, regravar `vendor/fiscal-api-X.Y.Z.tgz` com o MESMO nome
// e conteúdo novo NÃO falha — `npm ci`/`npm install` instalam calados o conteúdo ANTIGO (o lock guarda a integridade antiga e o cache a
// entrega); só um cache vazio recusa com EINTEGRITY. CERCA: arquivo do git = integridade do lock = pacote INSTALADO, byte a byte.
// (Arquivo GÊMEO em nfse-api, nfe-api e setes-api — mudar um = mudar os três.)
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import { execFileSync } from 'child_process'

const ROOT = path.resolve(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const spec = String(pkg.dependencies?.['fiscal-api'])
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
const installedDir = path.dirname(require.resolve('fiscal-api/package.json'))

/** Arquivos de um .tgz do npm (tar ustar dentro de gzip): caminho sem o prefixo `package/` → bytes. */
function tgzFiles(file: string): Map<string, Buffer> {
  const tar = zlib.gunzipSync(fs.readFileSync(file))
  const out = new Map<string, Buffer>()
  let off = 0
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512)
    if (h.every(b => b === 0)) break
    const str = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0[\s\S]*$/, '')
    const name = (str(345, 155) ? str(345, 155) + '/' : '') + str(0, 100)
    const size = parseInt(str(124, 12).trim() || '0', 8)
    const type = str(156, 1)
    if (type === '0' || type === '') out.set(name.replace(/^package\//, ''), Buffer.from(tar.subarray(off + 512, off + 512 + size)))
    off += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

describe('núcleo fiscal pelo pacote versionado — vendor = lock = instalado (D-F221/D-F222, achado 1 do gate socrático)', () => {
  // D-F226: número de RASCUNHO por iteração de frente (`1.1.0-ne3.1`) — arquivo novo a cada tentativa; nunca no `main`
  const m = /^file:(vendor\/fiscal-api-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-z][0-9a-z]*\.[1-9]\d*)?)\.tgz)$/.exec(spec)

  it('a dependência é o arquivo do pacote em vendor/, com versão marcada no nome (nunca a pasta irmã)', () => {
    expect(m).not.toBeNull()
    expect(fs.existsSync(path.join(ROOT, m![1]))).toBe(true)
  })

  it('[D-F226] no `main` o núcleo é uma versão FINAL — número de rascunho (`X.Y.Z-frente.N`) só em branch de frente', () => {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    let onMain = false
    try {
      const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
      if (branch === 'main') onMain = true
      // HEAD destacado (gate adversarial do delta, LOW 3): o commit que já está no `main` também é "o main"
      else if (branch === 'HEAD') { try { git('merge-base', '--is-ancestor', 'HEAD', 'main'); onMain = true } catch { /* fora do main */ } }
    } catch { /* sem git: nada a conferir aqui — o boot registra a versão do núcleo */ }
    if (onMain) expect(m![2]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('o lock aponta para o MESMO arquivo e guarda a integridade DELE (sha512 do vendor = integrity do lock)', () => {
    const entry = lock.packages?.['node_modules/fiscal-api']
    expect(entry?.resolved).toBe(spec)
    const sha = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(path.join(ROOT, m![1]))).digest('base64')
    expect(entry?.integrity).toBe(sha)
    expect(entry?.version).toBe(m![2])
  })

  it('o `fiscal-api` que ESTE processo resolve é o pacote instalado; o tsconfig EFETIVO (com `extends`) não o mapeia; nada de jest.config.* (gate adversarial do delta, M1)', () => {
    const realModules = fs.realpathSync(path.join(ROOT, 'node_modules')) + path.sep
    expect(fs.realpathSync(require.resolve('fiscal-api')).startsWith(realModules)).toBe(true)
    const ts = require('typescript') as typeof import('typescript')
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { /* tsconfig ilegível: o compilador já recusa */ } }
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, 'tsconfig.json'), {}, host)
    expect(JSON.stringify(parsed?.options.paths ?? {})).not.toMatch(/fiscal-api/)
    expect(fs.readdirSync(ROOT).filter(f => /^jest\.config\./.test(f))).toEqual([])
  })

  it('[gate adversarial do delta, LOW 4] o arquivo de uma versão NUNCA é regravado: o vendor/ é o MESMO blob do commit que o acrescentou', () => {
    const rel = m![1]
    let added = ''
    try {
      added = execFileSync('git', ['log', '--diff-filter=A', '--format=%H', '--', rel], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop() ?? ''
    } catch { /* sem git */ }
    if (!added) return                                                          // arquivo ainda não commitado (iteração de frente) ou sem git
    const blobThen = execFileSync('git', ['rev-parse', `${added}:${rel}`], { cwd: ROOT, encoding: 'utf8' }).trim()
    const blobNow = execFileSync('git', ['hash-object', rel], { cwd: ROOT, encoding: 'utf8' }).trim()
    expect(blobNow).toBe(blobThen)
  })

  it('nenhum atalho para a pasta irmã volta: nem `paths` no tsconfig, nem `moduleNameMapper` no jest para `fiscal-api` (D-F222)', () => {
    const ts = require('typescript') as typeof import('typescript')
    const cfg = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile).config ?? {}
    const paths: Record<string, string[]> = cfg.compilerOptions?.paths ?? {}
    expect(Object.entries(paths).filter(([k, v]) => /fiscal-api/.test(k) || v.some(t => /fiscal-api/.test(t)))).toEqual([])
    const mapper: Record<string, string> = pkg.jest?.moduleNameMapper ?? {}
    expect(Object.entries(mapper).filter(([k, v]) => /fiscal-api/.test(k) || /fiscal-api/.test(String(v)))).toEqual([])
  })

  it('o instalado em node_modules É o conteúdo do arquivo — nenhum arquivo a mais, a menos ou diferente (pega o cache do npm)', () => {
    expect(installedDir.startsWith(fs.realpathSync(path.join(ROOT, 'node_modules')) + path.sep)).toBe(true)   // junção/link para fora = a pasta irmã de volta
    expect(JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8')).version).toBe(m![2])
    const packed = tgzFiles(path.join(ROOT, m![1]))
    const installed = new Map<string, Buffer>()
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { if (!(d === installedDir && e.name === 'node_modules')) walk(p) }
        else installed.set(path.relative(installedDir, p).split(path.sep).join('/'), fs.readFileSync(p))
      }
    }
    walk(installedDir)
    expect([...installed.keys()].sort()).toEqual([...packed.keys()].sort())
    const differ = [...packed].filter(([f, b]) => !b.equals(installed.get(f)!)).map(([f]) => f)
    expect(differ).toEqual([])
  })
})
