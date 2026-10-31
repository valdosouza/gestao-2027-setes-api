import { createHash } from 'crypto'

/** Teto do que se normaliza: o e-mail de login cabe em 100 (`tb_mailing.email` varchar(100)); 320 = o máximo de um e-mail (RFC 5321). */
const MAX_EMAIL_CHARS = 320

/**
 * Forma CANÔNICA do e-mail de login para o limite por e-mail em memória (Q-PV38): aproxima a igualdade que a busca do login faz
 * pela colação `utf8mb4_general_ci` de `tb_mailing.email` — sem caixa, sem acento (NFKD sem marcas), `ß` = `s` e `ı` = `i` (as duas
 * dobras da general_ci que o NFKD não faz — levantadas no banco, faixa Latin-1 + Latin Extended-A/B, 2026-10-18) e PAD SPACE (só o
 * espaço do FIM não conta; o do início conta). Variante que o banco iguala cai no MESMO balde; o que sobrar (dobra fora dessas faixas)
 * só abre outro balde para a MESMA conta — a garantia durável é o teto por conta do pedido de troca de senha, não esta forma.
 * Não é validação, não é a forma gravada e não entra no HMAC (o HMAC usa o e-mail GRAVADO).
 */
export function normalizeLoginEmail(email: string): string {
  return String(email).slice(0, MAX_EMAIL_CHARS)
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/ß/g, 's').replace(/ı/g, 'i')           // ANTES das minúsculas: 'ẞ' (U+1E9E) vira 'ß' só depois e fica fora — o banco
    .toLowerCase()                                   // também NÃO iguala 'STRAẞE' a 'strase' nem a 'strasse' (conferido ao vivo)
    .replace(/ +$/, '')
}

/**
 * A coerção ÚNICA dos campos de texto das rotas públicas de senha (limite por e-mail e handlers — gate adversarial do delta): texto e
 * número viram texto (um e-mail em array também — `String(['a@x'])` = 'a@x', a mesma conta, o mesmo balde); o que não vira texto
 * (`{"toString":1}` lança TypeError) vira vazio = campo AUSENTE → 400, nunca 500.
 */
export function bodyText(value: unknown): string {
  if (!value) return ''                              // a mesma recusa do `!campo` de antes (undefined, null, '', 0, false)
  try {
    return String(value)
  } catch {
    return ''
  }
}

/**
 * Chave de TAMANHO FIXO do limite por e-mail (gate socrático da Q-PV38, HIGH): o corpo aceita até 2 MB e o e-mail virava chave do
 * MemoryStore como veio — um IP sozinho enchia a memória do processo. Agora a chave é o SHA-256 da forma canônica (64 hex).
 */
export function loginEmailBucket(email: string): string {
  return createHash('sha256').update(normalizeLoginEmail(email)).digest('hex')
}
