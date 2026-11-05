import fs from 'fs'
import path from 'path'
import { z } from 'zod'

/**
 * POLÍTICA DE SENHA — regra ÚNICA de toda senha NOVA (Onda 3 do endurecer, `Infra-IA/prompts/prompt_endurecer_autenticacao.md`):
 * D-EA5 (mínimo 8, máximo 100, SEM classes obrigatórias — NIST SP 800-63B; recusa a lista de comuns, a senha que contém a parte local do
 * e-mail de login e a igual à atual), D-EA13 (nunca só espaços — absorvido do antigo `newPasswordSchema`), D-EA16 (a parte local só conta
 * com 4+ caracteres, sem caixa e sem acento) e A-EA9 (lista comparada sem caixa, arquivo no repositório, carregado UMA vez; o boot recusa
 * subir sem ele).
 *
 * ESPELHO: `setes-app/packages/setes_validators/lib/src/password_policy.dart` — o MESMO julgamento, as MESMAS mensagens. Garantido por
 * construção: o vetor de casos `password-policy.vector.json` (ao lado) é lido pelas DUAS suítes; a lista do app é conferida pelo SHA-256.
 *
 * Senhas EXISTENTES mais curtas seguem valendo no login (nada força troca — D-EA5): a política só julga quem DEFINE senha.
 * "Igual à atual" NÃO mora aqui: depende do hash gravado e só pode ser julgada DEPOIS da prova de posse (código conferido, sob a trava —
 * §P.5 PP5); quem tem a atual chama `passwordMatches` e responde com `PASSWORD_PROBLEM_MESSAGES['same-as-current']`.
 */

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 100
/** D-EA16: a parte local do e-mail só é julgada com 4+ caracteres (já sem caixa e sem acento). */
export const EMAIL_LOCAL_MIN_LENGTH = 4

export type PasswordProblem = 'blank' | 'too-short' | 'too-long' | 'common' | 'contains-email' | 'same-as-current'

/** Uma mensagem por problema (Framework de Mensagens — uma pendência por vez). O espelho Dart repete o MESMO texto (o vetor confere). */
export const PASSWORD_PROBLEM_MESSAGES: Record<PasswordProblem, string> = {
  'blank':           'A senha não pode ser só espaços',
  'too-short':       `A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`,
  'too-long':        `A senha deve ter no máximo ${PASSWORD_MAX_LENGTH} caracteres`,
  'common':          'Esta senha é muito comum — escolha outra',
  'contains-email':  'A senha não pode conter o nome do seu e-mail (o trecho antes do @)',
  'same-as-current': 'A nova senha deve ser diferente da atual',
}

/** A regra mostrada no campo (D-EA5: "o app mostra a regra no campo"). */
export const PASSWORD_RULE_HINT =
  `Mínimo de ${PASSWORD_MIN_LENGTH} caracteres. Não use senhas comuns nem o nome do seu e-mail.`

/**
 * Tirar acento: tabela EXPLÍCITA (não `normalize('NFD')`) — o Dart não tem normalização Unicode no núcleo, e as duas pontas precisam do
 * MESMO resultado. Aplicada DEPOIS do `toLowerCase()`. O vetor cobre cada letra da tabela.
 */
const ACCENT_FOLD: Record<string, string> = {
  'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
  'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
  'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
  'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
  'ç': 'c', 'ñ': 'n', 'ý': 'y', 'ÿ': 'y',
}

/** Sem caixa e sem acento (D-EA16) — a forma em que a senha e a parte local do e-mail são comparadas. */
export function foldForComparison(value: string): string {
  let out = ''
  for (const ch of value.toLowerCase()) out += ACCENT_FOLD[ch] ?? ch
  return out
}

/** A parte local (antes do 1º `@`) do e-mail de login, já dobrada; vazia quando não há `@` ou o valor não é texto. */
export function emailLocalPart(email: string | null | undefined): string {
  if (typeof email !== 'string') return ''
  const at = email.indexOf('@')
  return at > 0 ? foldForComparison(email.slice(0, at).trim()) : ''
}

// ---------------------------------------------------------------- lista de senhas comuns (A-EA9)

/** `setes-api/data/common-passwords.txt` — fora de `src/` para valer igual rodando por `tsx` (src/shared/auth) e pelo `dist/` (dist/shared/auth):
 *  os dois ficam três níveis abaixo da raiz do projeto. `COMMON_PASSWORDS_FILE` no ambiente sobrescreve (testes). */
export const COMMON_PASSWORDS_FILE = process.env.COMMON_PASSWORDS_FILE
  ?? path.resolve(__dirname, '..', '..', '..', 'data', 'common-passwords.txt')

/** Lê o arquivo: uma senha por linha, já em minúsculas; linhas vazias e as que começam por `#` (cabeçalho de origem/licença) ignoradas. */
export function parseCommonPasswords(text: string): Set<string> {
  const set = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue
    set.add(raw.toLowerCase())
  }
  return set
}

let commonCache: Set<string> | null = null

/** A lista, carregada UMA vez (síncrono — o boot chama `assertPasswordPolicyReady` antes de abrir a porta). */
export function commonPasswords(): Set<string> {
  if (!commonCache) commonCache = parseCommonPasswords(fs.readFileSync(COMMON_PASSWORDS_FILE, 'utf-8'))
  return commonCache
}

/** Boot (A-EA9): sem o arquivo, ou com ele vazio, o setes-api NÃO sobe — a política sem a lista aceitaria "12345678". */
export function assertPasswordPolicyReady(): number {
  let size: number
  try {
    size = commonPasswords().size
  } catch (err) {
    throw new Error(`Política de senha (D-EA5/A-EA9): a lista de senhas comuns ${COMMON_PASSWORDS_FILE} não pôde ser lida — `
      + `${(err as Error).message}`)
  }
  if (size === 0) throw new Error(`Política de senha (D-EA5/A-EA9): a lista de senhas comuns ${COMMON_PASSWORDS_FILE} está vazia`)
  return size
}

// ---------------------------------------------------------------- o julgamento

/**
 * Os problemas da senha NOVA, em ordem de prioridade (o primeiro é o que a tela mostra). `loginEmail` = o e-mail de LOGIN da conta (o do
 * corpo no cadastro — imutável no PUT, D-UC1; o digitado na troca pelo código: a regra só olha o texto, não a conta, então julgar antes do
 * código não vira oráculo).
 */
export function passwordProblems(password: string, loginEmail?: string | null, common: Set<string> = commonPasswords()): PasswordProblem[] {
  const problems: PasswordProblem[] = []
  if (password.trim().length === 0) return ['blank']
  if (password.length < PASSWORD_MIN_LENGTH) problems.push('too-short')
  if (password.length > PASSWORD_MAX_LENGTH) problems.push('too-long')
  if (common.has(password.toLowerCase())) problems.push('common')
  const local = emailLocalPart(loginEmail)
  if (local.length >= EMAIL_LOCAL_MIN_LENGTH && foldForComparison(password).includes(local)) problems.push('contains-email')
  return problems
}

/** A forma do campo sozinho (tamanho e só espaços) — a peça Zod de quem ainda não conhece o e-mail. O resto vem pelo `refinePassword`. */
export const newPasswordSchema = z.string().superRefine((value, ctx) => {
  const first = passwordProblems(value, null, new Set()).find(p => p === 'blank' || p === 'too-short' || p === 'too-long')
  if (first) ctx.addIssue({ code: z.ZodIssueCode.custom, message: PASSWORD_PROBLEM_MESSAGES[first] })
})

/**
 * O julgamento COMPLETO num objeto que tem a senha e o e-mail de login lado a lado (users POST/PUT, admin do onboarding): a 1ª pendência
 * vai ao campo da senha (`fields[]` ancorado nele). A forma do campo já foi julgada pelo `newPasswordSchema` — aqui só lista e e-mail.
 * Senha ausente/nula (PUT sem trocar) = nada a julgar.
 */
export function refinePassword<T extends Record<string, unknown>>(passwordKey: keyof T & string, emailKey: keyof T & string) {
  return (value: T, ctx: z.RefinementCtx) => {
    const password = value[passwordKey]
    if (typeof password !== 'string') return
    const first = passwordProblems(password, value[emailKey] as string | undefined)
      .find(p => p === 'common' || p === 'contains-email')
    if (first) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [passwordKey], message: PASSWORD_PROBLEM_MESSAGES[first] })
  }
}
