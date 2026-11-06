/// <reference types="jest" />
// GATE ADVERSARIAL — Onda 3 do endurecer a autenticação (POLÍTICA DE SENHA única — D-EA5/D-EA13/D-EA16/A-EA9/D-EA36;
// `Infra-IA/prompts/prompt_endurecer_autenticacao.md` §P.5 PP1–PP6, PA1–PA5). Skill `Infra-IA/skills-genericas/testar-adversarial.md`.
// [ACHADO <SEV>] = `it.failing` (o teste descreve o comportamento CORRETO e hoje falha); [RESISTIU] = `it` verde.
// Banco DUBLADO: nada aqui toca `setes_central`/`setes_setes`.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHmac } from 'crypto'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/auth/product-token', () => ({
  __esModule: true, ...jest.requireActual('../shared/auth/product-token'),
  deriveProductSecret: jest.fn(() => Buffer.alloc(32, 7)),
}))
jest.mock('../modules/auth/auth.repository', () => ({
  __esModule: true, ...jest.requireActual('../modules/auth/auth.repository'),
  lockUserCredential: jest.fn(), readCurrentPasswordReset: jest.fn(), recordFailedPasswordResetAttempt: jest.fn(),
  updatePassword: jest.fn(), markPasswordResetUsed: jest.fn(),
}))

import {
  passwordProblems, parseCommonPasswords, commonPasswords, PASSWORD_MAX_LENGTH,
} from '../shared/auth/password-policy'
import { md5Password } from '../shared/auth/password'
import { bodyText } from '../shared/auth/login-email'
import { userCreateDto, userUpdateDto } from '../modules/users/users.dto'
import { judgePasswordResetCode } from '../modules/auth/auth.service'
import * as repo from '../modules/auth/auth.repository'
import { generateInitialPassword } from '../modules/auth/super-password-reset'

const issuesOf = (r: { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } }) =>
  r.success ? [] : r.error!.issues.map(i => [i.path.join('.'), i.message])

// ======================================================================================================== achados
describe('Onda 3 — ACHADOS (it.failing = comportamento correto ainda não cumprido)', () => {
  it('[CORRIGIDO·LOW] D-EA13 na fonte da verdade: senha só de U+0085 (NEL, White_Space do Unicode) passa na API — o Dart VM a recusa como "blank"', () => {
    // JS `String.prototype.trim` NÃO apara U+0085; o `String.trim` do Dart apara (medido: dart run × node, 2026-11-05).
    expect(passwordProblems('\u0085'.repeat(8))).toEqual(['blank'])
  })

  it('[CORRIGIDO·LOW] API × app (Android/VM): "İLOVEYOU" (I com ponto, U+0130) contorna a lista na API; o Dart VM baixa para "iloveyou" e recusa', () => {
    expect(commonPasswords().has('iloveyou')).toBe(true)
    // JS: 'İ'.toLowerCase() = 'i' + U+0307 (2 unidades) → não casa com a lista; Dart VM: 'İ'.toLowerCase() = 'i'.
    expect(passwordProblems('İLOVEYOU')).toContain('common')
  })

  it('[CORRIGIDO·LOW] D-EA16 "sem acento": a parte local do e-mail em NFD (acento combinante) contorna a regra nas DUAS pontas', () => {
    // a tabela explícita só conhece letras pré-compostas (NFC); 'joa' + U+0303 + 'o' sobrevive à dobra
    expect(passwordProblems('minhaSenhaJoão1', 'joao@x.com')).toContain('contains-email')
  })

  it('[LIMITE CONHECIDO — D-EA40] troca pelo código julga o e-mail DIGITADO: variante que a colação do banco iguala ao login (ı = i, ß = ss) passa pela regra do e-mail', () => {
    // `findUserByEmail` acha 'ilda@x.com' digitando 'ılda@x.com' (general_ci: ı = i — `normalizeLoginEmail`), mas a dobra da
    // política não conhece 'ı': o titular (que tem o código) grava 'ilda2026'. Valdo (D-EA40, "(a) Limite conhecido"): é o próprio
    // titular escolhendo senha fraca, não ataque — este teste FIXA a semântica para ninguém "consertar" sem decisão.
    expect(passwordProblems('ilda2026', 'ılda@x.com')).not.toContain('contains-email')
    expect(passwordProblems('ilda2026', 'ilda@x.com')).toContain('contains-email')   // com o e-mail igual ao da conta, recusa
    expect(passwordProblems('strasse-2026', 'straße@x.com')).not.toContain('contains-email')
  })

  it('[CORRIGIDO·LOW — D-EA39] pares substitutos ÓRFÃOS: a política recusa (invalid-char) antes de o MD5 os igualar a U+FFFD', () => {
    const a = '\uD800'.repeat(8), b = '\uDC01'.repeat(8)
    expect(passwordProblems(a)).toContain('invalid-char')
    expect(passwordProblems(b)).toContain('invalid-char')
    // conhecimento negativo (segue valendo até a Onda 4 trocar o MD5): o Buffer utf-8 troca todo substituto órfão por U+FFFD
    expect(md5Password(a)).toBe(md5Password(b))
  })

  it('[CORRIGIDO·LOW] lista com BOM: `parseCommonPasswords` não tira o U+FEFF — a 1ª entrada de um arquivo sem cabeçalho se perde', () => {
    expect(parseCommonPasswords('﻿12345678\r\nsenha123\r\n').has('12345678')).toBe(true)
  })

  it('[CORRIGIDO·LOW] /auth/change-password com newPassword = {} (ou número, lista) é recusado com 400 antes de tudo, como o login (A-EA8)', async () => {
    // a rota agora só aceita TEXTO no newPassword (auth.routes.ts) — antes o `bodyText` coagia {} para "[object Object]"
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const request = require('supertest') as typeof import('supertest')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const app = (require('../app') as { default: import('express').Express }).default
    for (const newPassword of [{}, 12345678, ['kq7#mv2x'], true]) {
      const r = await request(app).post('/auth/change-password').send({ email: 'p9@x.com', code: '123456', newPassword })
      expect(r.status).toBe(400)
    }
    expect(passwordProblems(bodyText({}))).toEqual([])   // o motivo do achado: a coerção sozinha passaria na política
  }, 60_000)   // a 1ª carga do app inteiro (require('../app')) passa de 5 s sob carga

  it('[CORRIGIDO·LOW] uma pendência por vez (PP1): o DTO devolve DUAS pendências para o campo password ("valdo" + valdo@…)', () => {
    const r = userCreateDto.safeParse({ nameCompany: 'a', nickTrade: 'a', email: 'valdo@setes.com.br', password: 'valdo' })
    expect(issuesOf(r)).toHaveLength(1)
  })
})

// ======================================================================================================== resistências
describe('Onda 3 — RESISTIU', () => {
  it('[RESISTIU] PP5 sem oráculo útil: com o código CERTO, palpite ERRADO da senha atual TROCA a senha e gasta o código (1 bit por código, ruidoso)', async () => {
    const hash = md5Password('atual-kq7#mv2x')
    const user = { id: 10, password: hash, active: 'S', loginEmail: 'p@x.com' } as any
    const codeHmac = createHmac('sha256', Buffer.alloc(32, 7)).update(`10:1:${hash}:p@x.com:123456`).digest('hex')
    ;(repo.lockUserCredential as jest.Mock).mockResolvedValue({ active: 'S', password: hash })
    ;(repo.readCurrentPasswordReset as jest.Mock).mockResolvedValue({ seq: 1, open: true, fresh: true, failedAttempts: 0, codeHmac })
    const conn = {} as any
    // palpite certo: 422 sem gastar (decidido no PP5)
    expect((await judgePasswordResetCode(conn, user, '123456', hash, 'atual-kq7#mv2x')).verdict).toBe('same-as-current')
    expect(repo.updatePassword).not.toHaveBeenCalled()
    // palpite errado: a troca ACONTECE e o código é marcado usado — não dá para sondar em silêncio
    expect((await judgePasswordResetCode(conn, user, '123456', md5Password('palpite-1x'), 'palpite-1x')).verdict).toBe('changed')
    expect(repo.updatePassword).toHaveBeenCalledTimes(1)
    expect(repo.markPasswordResetUsed).toHaveBeenCalledTimes(1)
    // código errado + senha igual à atual: 'wrong' (conta erro), nunca 'same-as-current'
    jest.clearAllMocks()
    ;(repo.lockUserCredential as jest.Mock).mockResolvedValue({ active: 'S', password: hash })
    ;(repo.readCurrentPasswordReset as jest.Mock).mockResolvedValue({ seq: 1, open: true, fresh: true, failedAttempts: 0, codeHmac })
    expect((await judgePasswordResetCode(conn, user, '654321', hash, 'atual-kq7#mv2x')).verdict).toBe('wrong')
    expect(repo.recordFailedPasswordResetAttempt).toHaveBeenCalledTimes(1)
  })

  it('[RESISTIU] lista sem caixa e brasileiras: PASSWORD, SeNhA123, FLAMENGO, Mudar123', () => {
    for (const p of ['PASSWORD', 'SeNhA123', 'FLAMENGO', 'Mudar123']) expect(passwordProblems(p)).toContain('common')
  })

  it('[RESISTIU] D-EA13: espaços ASCII, NBSP, U+3000, U+2028 e BOM puros = blank', () => {
    for (const ch of [' ', '\t', ' ', '　', ' ', '﻿']) expect(passwordProblems(ch.repeat(9))).toEqual(['blank'])
  })

  it('[RESISTIU] limite 100 por unidade UTF-16 (o mesmo do Dart `String.length`): 50 emoji passam, 50 emoji + 1 recusam', () => {
    const fifty = '😀'.repeat(50)
    expect(fifty.length).toBe(PASSWORD_MAX_LENGTH)
    expect(passwordProblems(fifty)).toEqual([])
    expect(passwordProblems(fifty + 'a')).toEqual(['too-long'])
  })

  it('[RESISTIU] e-mail: caixa, acento pré-composto e espaço nas pontas da parte local não contornam; e-mail com dois @ cai no DTO', () => {
    expect(passwordProblems('xx-VALDO-xx', '  VÁLDO@setes.com.br')).toContain('contains-email')
    const r = userCreateDto.safeParse({ nameCompany: 'a', nickTrade: 'a', email: 'a@b@c.com', password: 'kq7#mv2x' })
    expect(issuesOf(r).some(([p]) => p === 'email')).toBe(true)
  })

  it('[RESISTIU] tipos não-texto no DTO: número, array, objeto e booleano em password = 400 de validação (nunca 500)', () => {
    for (const password of [12345678, ['kq7#mv2x'], { a: 1 }, true]) {
      const r = userCreateDto.safeParse({ nameCompany: 'a', nickTrade: 'a', email: 'x@y.com', password })
      expect(issuesOf(r).some(([p]) => p === 'password')).toBe(true)
    }
  })

  it('[RESISTIU] PUT sem senha (ausente/null) não julga nada; PUT com senha comum é recusado no campo password', () => {
    const base = { nameCompany: 'a', nickTrade: 'a', email: 'x@y.com' }
    expect(userUpdateDto.safeParse(base).success).toBe(true)
    expect(userUpdateDto.safeParse({ ...base, password: null }).success).toBe(true)
    expect(issuesOf(userUpdateDto.safeParse({ ...base, password: '12345678' }))).toEqual([['password', expect.any(String)]])
  })

  it('[RESISTIU] PP6: a senha inicial do script do Super passa na política (1.000 amostras)', () => {
    for (let i = 0; i < 1000; i++) expect(passwordProblems(generateInitialPassword())).toEqual([])
  })

  it('[RESISTIU] A-EA9: boot sem o arquivo, ou com ele só de cabeçalho, recusa subir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda3-gate-'))
    try {
      for (const [name, body] of [['ausente.txt', null], ['so-cabecalho.txt', '# cabeçalho\r\n# outro\r\n\r\n']] as const) {
        const file = path.join(dir, name)
        if (body !== null) fs.writeFileSync(file, body, 'utf-8')
        const saved = process.env.COMMON_PASSWORDS_FILE
        process.env.COMMON_PASSWORDS_FILE = file
        try {
          jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fresh = require('../shared/auth/password-policy') as typeof import('../shared/auth/password-policy')
            expect(() => fresh.assertPasswordPolicyReady()).toThrow(/Política de senha/)
          })
        } finally {
          if (saved === undefined) delete process.env.COMMON_PASSWORDS_FILE
          else process.env.COMMON_PASSWORDS_FILE = saved
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('[RESISTIU] arquivo com CRLF: as entradas casam (o \\r não gruda na senha)', () => {
    expect(parseCommonPasswords('# x\r\n12345678\r\nSenha123\r\n').has('senha123')).toBe(true)
  })

  it('[RESISTIU] o arquivo real: sem espaço no fim de linha, sem entrada < 8, todas em minúsculas', () => {
    const lines = fs.readFileSync(path.resolve(__dirname, '..', '..', 'data', 'common-passwords.txt'), 'utf-8')
      .split(/\r?\n/).filter(l => l && !l.startsWith('#'))
    expect(lines.length).toBeGreaterThan(1000)
    for (const l of lines) {
      expect(l).toBe(l.trim()); expect(l.length).toBeGreaterThanOrEqual(8); expect(l).toBe(l.toLowerCase())
    }
  })
})
