import { createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto'

// ---------------------------------------------------------------------
// O HASH DA SENHA da casa — Onda 4 do endurecer (`Infra-IA/prompts/prompt_endurecer_autenticacao.md` §P.14; D-EA9/D-EA17/D-EA18).
// A ÚNICA peça que grava e confere senha: `hashPassword` (todo escritor) e `checkPassword` (login, troca pelo código).
//   - Formato novo: `scrypt$N=<N>,r=<r>,p=<p>$<sal b64>$<hash b64>` (sal 16 bytes, chave 32 bytes, base64 PADRÃO com `=`) — ≤ 93
//     caracteres, cabe no `tb_user.password varchar(100)` (hex não caberia). Cada valor CARREGA o seu peso: senha gravada com peso
//     antigo segue conferindo até o recálculo (D-EA18).
//   - LEGADO: MD5 em 32 hex (decisão 2 da Fase 2, aposentada pela D-EA9) — só CONFERE; quando bate, `needsRehash` (o login regrava em
//     scrypt na mesma transação, por compare-and-set, sem tocar `password_set_at`).
//   - Qualquer outra forma (texto puro, prefixo sem partes, base64 fora do canônico, peso fora da lista ACEITA) = `invalid`: NUNCA calcula
//     (um `N` absurdo estouraria a memória) — o caller recusa neutro e alarma.
// Conhecimento negativo: NUNCA `scryptSync` — 1,3 s por verificação (p=3, máquina do dev) segurando o laço de eventos parariam a API inteira.
// O `scrypt` assíncrono roda no pool do libuv (4 threads por padrão, o MESMO de `fs`/DNS) — por isso o hash nunca fica sob a trava da linha
// nem com uma conexão do pool presa: quem chama calcula ANTES de travar (protocolo do §P.3, ajuste (b)).
// ---------------------------------------------------------------------

export interface ScryptParams { N: number; r: number; p: number }

/**
 * O PESO VIGENTE (D-EA9 `N=2^15, r=8, p=3`; PROVISÓRIO pela D-EA18 — a medição no servidor real, D-EA17, confirma ou ajusta). O ÚNICO
 * lugar do peso no código (cerca H10: nenhum `N=`/`r=`/`p=` literal fora desta peça); nunca no `.env` (valor versionado, revisado).
 * Trocar aqui = o próximo login CERTO de cada conta recalcula no peso novo (mesmo caminho da migração do MD5).
 */
export const SCRYPT_CURRENT: Readonly<ScryptParams> = Object.freeze({ N: 2 ** 15, r: 8, p: 3 })

/** Pesos que a peça aceita CONFERIR (um valor gravado fora daqui = `invalid`, sem cálculo). Gravar, só com o vigente. */
export const SCRYPT_ACCEPTED_N: readonly number[] = Object.freeze([2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17])
export const SCRYPT_ACCEPTED_R = 8
export const SCRYPT_ACCEPTED_P_MAX = 4

export const SCRYPT_SALT_BYTES = 16
export const SCRYPT_KEY_BYTES = 32

/**
 * `maxmem` EXPLÍCITO: o scrypt usa ≈ 128·N·r bytes (N=2^15, r=8 → 32 MiB), e esse número é EXATAMENTE o padrão do Node — que RECUSA a
 * chamada (`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`: a conta do Node soma o bloco de trabalho por cima). O teto é o dobro do necessário de cada
 * peso — limita, sem ser o próprio limite. Para o maior N aceito (2^17) = 256 MiB de teto (128 MiB de uso).
 * ⚠️ Conhecimento negativo (achado na Onda 4, Node v21.7.3): a recusa é SÍNCRONA e deixa um erro PRESO na fila do OpenSSL da thread
 * principal — a PRÓXIMA leitura de chave PEM do processo (a do JWT, no login seguinte) falha com `ERR_OSSL_EVP_MEMORY_LIMIT_EXCEEDED`.
 * Por isso a peça NUNCA chama o scrypt com peso fora da lista aceita nem sem este teto (teste em processo separado no
 * `password-scrypt-d-ea9.test.ts`).
 */
export function scryptMaxmem(params: ScryptParams): number {
  return 2 * 128 * params.N * params.r
}

let currentParams: ScryptParams = SCRYPT_CURRENT
/**
 * SÓ PARA TESTES E PROVAS (H10, o setup da suíte, `scripts/measure-scrypt.ts` e `scripts/prove-scrypt-migration.ts`): troca o peso
 * usado para GRAVAR e para decidir o `needsRehash`. Só pesos da lista aceita. Devolve o anterior. O código de produção (`src/` fora de
 * `__tests__`/`test-setup`) nunca chama — cerca no `password-scrypt-d-ea9.test.ts`.
 */
export function setCurrentScryptParamsForTests(params: ScryptParams): ScryptParams {
  if (!isAcceptedParams(params)) throw new Error('peso do scrypt fora da lista aceita')
  const previous = currentParams
  currentParams = { ...params }
  return previous
}
/** O peso em uso para gravar (SCRYPT_CURRENT, salvo nos testes). */
export function currentScryptParams(): Readonly<ScryptParams> {
  return currentParams
}

function isAcceptedParams(p: ScryptParams): boolean {
  return SCRYPT_ACCEPTED_N.includes(p.N) && p.r === SCRYPT_ACCEPTED_R
    && Number.isInteger(p.p) && p.p >= 1 && p.p <= SCRYPT_ACCEPTED_P_MAX
}

function sameParams(a: ScryptParams, b: ScryptParams): boolean {
  return a.N === b.N && a.r === b.r && a.p === b.p
}

function deriveKey(plain: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, SCRYPT_KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem: scryptMaxmem(params) },
      (err, key) => (err ? reject(err) : resolve(key)))
  })
}

function formatParams(p: ScryptParams): string {
  return `N=${p.N},r=${p.r},p=${p.p}`
}

/** O hash NOVO de uma senha, no peso vigente — o ÚNICO jeito de gravar senha (cerca H6). Assíncrono; nunca sob trava. */
export async function hashPassword(plain: string): Promise<string> {
  const params = currentParams
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const key = await deriveKey(plain, salt, params)
  return `scrypt$${formatParams(params)}$${salt.toString('base64')}$${key.toString('base64')}`
}

/** A forma de um valor gravado — `scrypt` (com o peso dele), `md5` (legado) ou `invalid` (recusa sem cálculo). */
export type StoredPasswordForm = 'scrypt' | 'md5' | 'invalid'

interface ParsedScrypt { params: ScryptParams; salt: Buffer; key: Buffer }

const SCRYPT_SHAPE = /^scrypt\$N=(\d{1,7}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=)$/
const MD5_SHAPE = /^[0-9A-Fa-f]{32}$/

function parseScrypt(stored: string): ParsedScrypt | null {
  const m = SCRYPT_SHAPE.exec(stored)
  if (!m) return null
  const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) }
  if (!isAcceptedParams(params)) return null
  const salt = Buffer.from(m[4], 'base64'), key = Buffer.from(m[5], 'base64')
  // base64 CANÔNICO (o decodificador do Node aceita bits sobrando no último caractere — reescrever tem de dar o MESMO texto)
  if (salt.toString('base64') !== m[4] || key.toString('base64') !== m[5]) return null
  if (salt.length !== SCRYPT_SALT_BYTES || key.length !== SCRYPT_KEY_BYTES) return null
  return { params, salt, key }
}

/** Classifica o valor gravado SEM calcular nada (pura). */
export function storedPasswordForm(stored: string | null | undefined): StoredPasswordForm {
  if (!stored) return 'invalid'
  if (MD5_SHAPE.test(stored)) return 'md5'
  return parseScrypt(stored) ? 'scrypt' : 'invalid'
}

export interface PasswordCheck {
  /** a senha digitada confere com o valor gravado */
  ok:          boolean
  /** confere E o valor gravado não está no formato/peso vigente — quem admite o login regrava (compare-and-set, sem `password_set_at`) */
  needsRehash: boolean
  form:        StoredPasswordForm
}

/**
 * CONFERE a senha digitada contra o valor gravado, em tempo constante nos dois formatos (`timingSafeEqual`). Assíncrona (scrypt). O peso
 * do cálculo é o DO VALOR GRAVADO. `invalid` (inclusive NULL/'') = não confere, sem cálculo — o caller recusa neutro e alarma (H2).
 * `needsRehash` só quando CONFERE (login errado nunca recalcula — H10).
 */
export async function checkPassword(plain: string, stored: string | null | undefined): Promise<PasswordCheck> {
  const form = storedPasswordForm(stored)
  if (form === 'md5') {
    const a = Buffer.from(md5Password(plain)), b = Buffer.from(String(stored).toUpperCase())
    const ok = a.length === b.length && timingSafeEqual(a, b)
    return { ok, needsRehash: ok, form }
  }
  if (form === 'scrypt') {
    const parsed = parseScrypt(String(stored))!
    const key = await deriveKey(plain, parsed.salt, parsed.params)
    const ok = key.length === parsed.key.length && timingSafeEqual(key, parsed.key)
    return { ok, needsRehash: ok && !sameParams(parsed.params, currentParams), form }
  }
  return { ok: false, needsRehash: false, form }
}

/**
 * O MD5 LEGADO (decisão 2 da Fase 2, aposentada pela D-EA9): só para CONFERIR o valor antigo (acima) e montar fixtures de legado nos
 * testes/provas. NENHUM escritor de produção chama (cerca H6 — `password-scrypt-d-ea9.test.ts`).
 */
export function md5Password(value: string): string {
  return createHash('md5').update(value).digest('hex').toUpperCase()
}

/**
 * A senha NOVA de uma credencial: a regra mora na peça da POLÍTICA (`./password-policy` — D-EA5, Onda 3 do endurecer), que absorveu a
 * D-EA13 (nunca só espaços). Reexportada aqui para os DTOs que já importavam deste caminho.
 */
export { newPasswordSchema } from './password-policy'

/**
 * D-EA7 (Valdo 2026-10-31 — `prompt_endurecer_autenticacao.md`; parecer do guardião): o FATO "a senha que vale hoje foi definida no instante
 * T", gravado AO LADO do hash (`tb_user.password_set_at`) SÓ por quem DEFINE a senha — criação da credencial, 1ª senha de conta sem
 * credencial (A-PV23), troca pelo código da recuperação, script do Super; nunca pelo salvar do cadastro nem pela migração do hash (D-EA9 —
 * `rehashPassword` do auth.repository, a exceção nomeada da cerca).
 * A sessão viva compara o `iat` do token com ele (token anterior = 401 SESSION_REVOKED). T vem do relógio de QUEM ASSINA O TOKEN (este
 * processo), truncado ao segundo, em UTC — nunca `NOW()` do banco: com o banco adiantado, o token reemitido na mesma resposta e o 1º login
 * logo após a criação cairiam (assunção do guardião, a ratificar — exceção nomeada à letra da PADROES §10 regra 1; o valor segue UTC).
 */
export function passwordSetAt(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19).replace('T', ' ')
}
