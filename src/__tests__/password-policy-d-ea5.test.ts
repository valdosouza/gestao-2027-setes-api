// Onda 3 do endurecer — POLÍTICA DE SENHA (D-EA5, D-EA13, D-EA16, A-EA9, D-EA36; `Infra-IA/prompts/prompt_endurecer_autenticacao.md`
// §P.5 item 2: PP1–PP6). A peça `@shared/auth/password-policy` contra o VETOR compartilhado com o espelho Dart, as portas que a usam e o
// arquivo da lista.
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import {
  passwordProblems, foldForComparison, emailLocalPart, PASSWORD_PROBLEM_MESSAGES, PASSWORD_RULE_HINT, PasswordProblem,
  parseCommonPasswords, commonPasswords, assertPasswordPolicyReady, COMMON_PASSWORDS_FILE, newPasswordSchema,
} from '../shared/auth/password-policy'
import { userCreateDto, userUpdateDto } from '../modules/users/users.dto'
import { institutionCreateDto } from '../modules/institutions/institutions.dto'
import { generateInitialPassword } from '../modules/auth/super-password-reset'

interface VectorCase { password: string, email: string | null, problems: PasswordProblem[] }
const vector = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'auth', 'password-policy.vector.json'), 'utf-8')) as {
  messages: Record<PasswordProblem, string>, hint: string, fold: [string, string][], cases: VectorCase[]
}

describe('D-EA5 — a peça contra o vetor (o MESMO que o espelho Dart lê)', () => {
  it.each(vector.cases.map(c => [JSON.stringify(c.password).slice(0, 40), c.email, c] as const))('%s · %s', (_p, _e, c) => {
    expect(passwordProblems(c.password, c.email)).toEqual(c.problems)
  })

  it('as mensagens e a dica do vetor são as da peça (a tela do app mostra o MESMO texto)', () => {
    expect(PASSWORD_PROBLEM_MESSAGES).toEqual(vector.messages)
    expect(PASSWORD_RULE_HINT).toBe(vector.hint)
  })

  it('tirar caixa e acento pela tabela do vetor (D-EA16 — nunca NFD: o Dart não tem)', () => {
    for (const [from, to] of vector.fold) expect(foldForComparison(from)).toBe(to)
  })

  it('PP2 — os casos de tamanho do vetor têm o tamanho que dizem ter', () => {
    const sizes = vector.cases.filter(c => /^x+$/.test(c.password)).map(c => c.password.length).sort()
    expect(sizes).toEqual([100, 101])
  })
})

describe('D-EA16 — parte local do e-mail', () => {
  it('antes do 1º @, aparada e dobrada; sem @ ou @ na 1ª posição = vazia', () => {
    expect(emailLocalPart('Valdo@setes.com.br')).toBe('valdo')
    expect(emailLocalPart('  JOÃO@x.com')).toBe('joao')
    expect(emailLocalPart('sem-arroba')).toBe('')
    expect(emailLocalPart('@x.com')).toBe('')
    expect(emailLocalPart(null)).toBe('')
    expect(emailLocalPart(42 as unknown as string)).toBe('')
  })
})

describe('A-EA9/D-EA36 — a lista de senhas comuns', () => {
  it('o arquivo existe, tem cabeçalho de origem e licença, e só entradas de 8 a 100 em minúsculas, sem repetição', () => {
    const text = fs.readFileSync(COMMON_PASSWORDS_FILE, 'utf-8')
    expect(text).toMatch(/^# .*D-EA5/)
    expect(text).toMatch(/MIT/)
    const lines = text.split('\n').filter(l => l && !l.startsWith('#'))
    expect(lines.length).toBeGreaterThan(2000)
    expect(new Set(lines).size).toBe(lines.length)
    for (const l of lines) {
      expect(l).toBe(l.toLowerCase())
      expect(l.length).toBeGreaterThanOrEqual(8)
      expect(l.length).toBeLessThanOrEqual(100)
    }
    expect(commonPasswords().size).toBe(lines.length)
  })

  it('a parte brasileira escrita à mão entrou (as de 8+ caracteres)', () => {
    const br = parseCommonPasswords(fs.readFileSync(path.resolve(path.dirname(COMMON_PASSWORDS_FILE), 'common-passwords-br.txt'), 'utf-8'))
    for (const e of br) if (e.length >= 8) expect(commonPasswords().has(e)).toBe(true)
  })

  it('o boot recusa subir sem o arquivo e com ele vazio', () => {
    jest.isolateModules(() => {
      process.env.COMMON_PASSWORDS_FILE = path.join(__dirname, 'nao-existe-common-passwords.txt')
      try {
        const peça = require('../shared/auth/password-policy') as typeof import('../shared/auth/password-policy')
        expect(() => peça.assertPasswordPolicyReady()).toThrow(/não pôde ser lida/)
      } finally { delete process.env.COMMON_PASSWORDS_FILE }
    })
    const vazio = path.join(require('os').tmpdir(), `common-vazio-${process.pid}.txt`)
    fs.writeFileSync(vazio, '# só cabeçalho\n')
    jest.isolateModules(() => {
      process.env.COMMON_PASSWORDS_FILE = vazio
      try {
        const peça = require('../shared/auth/password-policy') as typeof import('../shared/auth/password-policy')
        expect(() => peça.assertPasswordPolicyReady()).toThrow(/está vazia/)
      } finally { delete process.env.COMMON_PASSWORDS_FILE; fs.unlinkSync(vazio) }
    })
    expect(assertPasswordPolicyReady()).toBe(commonPasswords().size)
  })

  it('o boot recusa a lista truncada (menos entradas que o cabeçalho declara) e a lista sem o cabeçalho do gerador (gate socrático, LOW 3)', () => {
    const tmp = (name: string, body: string) => {
      const f = path.join(require('os').tmpdir(), `${name}-${process.pid}.txt`)
      fs.writeFileSync(f, body)
      return f
    }
    for (const [file, msg] of [
      [tmp('truncada', '# Filtro: x. 2231 entradas.\n12345678\n'), /declara 2231 entradas e tem 1/],
      [tmp('sem-cabecalho', '12345678\nsenha123\n'), /não tem o cabeçalho do gerador/],
    ] as const) {
      jest.isolateModules(() => {
        process.env.COMMON_PASSWORDS_FILE = file
        try {
          const peça = require('../shared/auth/password-policy') as typeof import('../shared/auth/password-policy')
          expect(() => peça.assertPasswordPolicyReady()).toThrow(msg)
        } finally { delete process.env.COMMON_PASSWORDS_FILE; fs.unlinkSync(file) }
      })
    }
  })

  it('a licença MIT vai INTEIRA nas duas cópias (gate socrático, LOW 7)', () => {
    const text = fs.readFileSync(COMMON_PASSWORDS_FILE, 'utf-8')
    expect(text).toMatch(/Copyright \(c\) 2018 Daniel Miessler/)
    expect(text).toMatch(/The above copyright notice and this permission notice shall be included in all/)
    const dartFile = path.resolve(__dirname, '..', '..', '..', 'setes-app', 'packages', 'setes_validators', 'lib', 'src', 'common_passwords.g.dart')
    if (fs.existsSync(dartFile)) expect(fs.readFileSync(dartFile, 'utf-8')).toMatch(/The above copyright notice and this permission notice shall be included in all/)
  })

  it('a cópia do app é a mesma lista (A-EA9 — conferida também do lado Dart, entrada por entrada)', () => {
    const dartFile = path.resolve(__dirname, '..', '..', '..', 'setes-app', 'packages', 'setes_validators', 'lib', 'src', 'common_passwords.g.dart')
    if (!fs.existsSync(dartFile)) return   // sem o setes-app ao lado; o lado Dart confere de qualquer forma
    const dart = fs.readFileSync(dartFile, 'utf-8')
    const fromDart = [...dart.matchAll(/^ {2}r?(['"])(.*)\1,\r?$/gm)   /* o checkout no Windows pode trazer CRLF */].map(m => m[2])
    expect(createHash('sha256').update(fromDart.join('\n')).digest('hex'))
      .toBe(createHash('sha256').update([...commonPasswords()].join('\n')).digest('hex'))
  })
})

describe('PP1 — as portas usam a MESMA peça e ancoram no campo da senha', () => {
  const base = { nameCompany: 'Fulano', nickTrade: 'Fulano', email: 'valdo@setes.com.br' }
  const firstMessage = (r: { success: boolean, error?: { issues: { path: (string | number)[], message: string }[] } }) =>
    r.success ? null : { path: r.error!.issues[0].path.join('.'), message: r.error!.issues[0].message }

  it.each([
    ['abcdefg', PASSWORD_PROBLEM_MESSAGES['too-short']],
    ['        ', PASSWORD_PROBLEM_MESSAGES['blank']],
    ['senha123', PASSWORD_PROBLEM_MESSAGES['common']],
    ['xvaldo99', PASSWORD_PROBLEM_MESSAGES['contains-email']],
  ])('users POST/PUT com %j → %s', (password, message) => {
    expect(firstMessage(userCreateDto.safeParse({ ...base, password }) as never)).toEqual({ path: 'password', message })
    expect(firstMessage(userUpdateDto.safeParse({ ...base, password }) as never)).toEqual({ path: 'password', message })
  })

  it('users PUT sem senha (null/ausente) não julga nada; senha boa passa', () => {
    expect(userUpdateDto.safeParse({ ...base, password: null }).success).toBe(true)
    expect(userUpdateDto.safeParse({ ...base }).success).toBe(true)
    expect(userCreateDto.safeParse({ ...base, password: 'kq7#mv2x' }).success).toBe(true)
  })

  it('admin do onboarding (institutions) recusa pelas mesmas regras, ancorado em admin.password', () => {
    const admin = (password: string) => ({ ...base, password })
    for (const [password, message] of [['abc12', PASSWORD_PROBLEM_MESSAGES['too-short']], ['12345678', PASSWORD_PROBLEM_MESSAGES['common']],
      ['valdo2026', PASSWORD_PROBLEM_MESSAGES['contains-email']]]) {
      const r = institutionCreateDto.safeParse({ admin: admin(password) })
      expect(r.success).toBe(false)
      const issue = r.error!.issues.find(i => i.path.join('.') === 'admin.password')
      expect(issue?.message).toBe(message)
    }
  })

  it('newPasswordSchema sozinho (sem e-mail) só julga a forma — a lista vem pelo refine do objeto', () => {
    expect(newPasswordSchema.safeParse('abcdefgh').success).toBe(true)
    expect(newPasswordSchema.safeParse('abcdefg').success).toBe(false)
  })
})

describe('PP6 — o que já existe segue', () => {
  it('a senha inicial do script do Super cumpre a política (amostra de 500)', () => {
    for (let i = 0; i < 500; i++) {
      const p = generateInitialPassword()
      expect(passwordProblems(p, 'super@setes.com.br')).toEqual([])
    }
  })
})
