/**
 * D-F98 (= Q-F104 (b)+(c), Valdo 2026-10-11): a resposta AMBÍGUA do fisco (502 FISCAL_AUTHORITY_UNKNOWN_RESPONSE) carrega uma CAUSA
 * de uma lista FECHADA — é ela, e só ela, que vai ao alarme "Fisco ambíguo persistente". Nunca texto da resposta nem da mensagem: a
 * mensagem já levou o Id do DPS de TERCEIRO (com o CPF/CNPJ dele), e a máscara de dígitos da D-F94 não tira as letras de um CNPJ
 * ALFANUMÉRICO (R18-01). Quem produz o ambíguo marca a causa (`tagAmbiguous`); quem alarma lê (`ambiguousCauseOf`) e só aceita valor
 * da lista — marca fora dela, ou ausente, vira `nao-classificada` (o alarme continua, sem texto).
 *
 * ⚠️ ESPELHO do núcleo `fiscal-api/src/errors/ambiguous-cause.ts` (a nfse-api) — este é o caminho de produção até a F2a; mudar os dois juntos.
 */
export const AMBIGUOUS_CAUSES = [
  'envelope-ilegivel',        // 2xx sem o envelope cravado (sem a NFS-e, sem JSON legível)
  'rota-nao-atendida',        // 405/406/415: o fisco não atende a rota/método/formato — contrato do adaptador
  'nfse-ilegivel',            // a NFS-e veio, mas o leitor não a lê
  'nfse-sem-chave',           // NFS-e sem a chave de acesso de 50 dígitos
  'nfse-chave-divergente',    // a chave da NFS-e não é a perguntada / a do envelope
  'nfse-de-outro-dps',        // a NFS-e embute OUTRO DPS (resposta trocada) — nunca o Id dele na mensagem (D-F98 (c))
  'nfse-sem-identidade',      // sem Id do infNFSe nem do infDPS
  'situacao-ilegivel',        // a consulta não chegou a uma situação legível e o adaptador não disse por quê (reserva)
  'evento-fora-do-contrato',  // GET tipado de evento fora da forma cravada (404 fora do envelope, 2xx sem lista, lista vazia)
  'evento-recusado',          // 401/403 na rota de EVENTO depois do 200 da NFS-e (D-F65)
  'evento-ilegivel',          // o evento veio e o leitor não o lê (nada decodifica, entidade inválida — R18-07) — gate R19 (S3/S5)
  'evento-nao-conferido',     // 200 de evento que não se confere como cancelamento GERADO desta chave (D-F63)
  'evento-sem-retorno',       // resposta ao pedido de evento sem o evento gerado para a chave
  'evento-contraditorio',     // o fisco se contradiz: tipos/conteúdos diferentes no GET tipado (D-F84/D-F88/D-F89), tipo ≠ perguntado
                              // (D-F69), outro tipo para a nota que o produto cancelou (D-F77)
  'dps-fora-do-contrato',     // GET /dps fora da forma cravada (2xx sem chave, 404 sem a forma do fisco)
] as const

export type AmbiguousCause = typeof AMBIGUOUS_CAUSES[number] | 'nao-classificada'

const KNOWN: ReadonlySet<string> = new Set(AMBIGUOUS_CAUSES)
/** Símbolo, não propriedade: nunca serializa no corpo HTTP nem no log por acidente. */
const CAUSE = Symbol.for('fiscal.ambiguousCause')

/** Marca a causa do ambíguo no erro e o devolve (para `throw tagAmbiguous(new …, 'causa')`). */
export function tagAmbiguous<E extends Error>(err: E, cause: AmbiguousCause): E {
  ;(err as any)[CAUSE] = cause
  return err
}

/** A causa marcada — só valor da lista FECHADA; qualquer outra coisa (ou nada) é `nao-classificada`. */
export function ambiguousCauseOf(err: unknown): AmbiguousCause {
  const c = err && typeof err === 'object' ? (err as any)[CAUSE] : undefined
  return typeof c === 'string' && KNOWN.has(c) ? (c as AmbiguousCause) : 'nao-classificada'
}
