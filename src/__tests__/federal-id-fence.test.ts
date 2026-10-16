/// <reference types="jest" />
// CERCA da inscrição federal (D-CJ12 = Q-CJ12, frente do CNPJ alfanumérico, Valdo 2026-10-15 — molde time-zone-fence/voice-kind-fence):
// "tirar o que não é dígito" (ou "tirar as letras") NUNCA sobre inscrição federal (CPF/CNPJ) nem chave de acesso — aplicado a um CNPJ
// alfanumérico dá OUTRO número (ou vira CPF: com 3 letras sobram 11 dígitos). A peça FederalId (núcleo, `fiscal-api/federal-id`,
// reexportada pelo @shared/validation) canonicaliza: tira só a máscara, nunca apaga. O PREDICADO mora no arquivo gêmeo
// `src/test-setup/federal-id-fence.ts` (idêntico ao `src/__tests__/federal-id-fence.ts` do fiscal-api e da nfse-api; alargado no gate
// adversarial da onda 0). Lista BRANCA = os usos legítimos, cada um com o MOTIVO; alarme NOVO fora dela quebra a cerca; entrada que SUMIU
// também quebra.
import path from 'path'
import { repoStrippingHits, strippingHitsIn, FENCE_PROBES_CAUGHT, FENCE_PROBES_CLEAN } from '../test-setup/federal-id-fence'

const ROOT = path.resolve(__dirname, '..', '..')

/** `arquivo: texto do alarme` (espaços colapsados) → motivo. */
const ALLOWED: Record<string, string> = {
  "src/shared/bank-channel/adapters/inter.ts: `${ctx.channel.accountNumber ?? ''}${ctx.channel.accountNumberDv ?? ''}`.replace(/\\D/g, '')":
    'conta corrente do canal do banco (dígitos)',
  "src/shared/bank-slip-registration/bank-slip-registration.ts: (addr?.zipCode ?? '').replace(/\\D/g, '')": 'CEP (8 dígitos)',
  "src/shared/ibscbs-classification/index.ts: filter.replace(/\\D/g, '')": 'filtro por código numérico do catálogo IBS/CBS (NBS/cClassTrib)',
}

describe('D-CJ12 — cerca: nunca "tirar o que não é dígito" de inscrição federal ou chave de acesso', () => {
  const hits = repoStrippingHits(ROOT)
  it('todo alarme está na lista branca (com o motivo)', () => {
    expect(hits.filter(h => !(h in ALLOWED))).toEqual([])
  })
  it('a lista branca não apodrece: toda entrada ainda existe no código', () => {
    expect(Object.keys(ALLOWED).filter(k => !hits.includes(k))).toEqual([])
  })
  it('a cerca enxerga o que deve (sonda — inclui as 9 formas que escapavam da 1ª versão)', () => {
    for (const code of FENCE_PROBES_CAUGHT) expect([code, strippingHitsIn(code).length > 0]).toEqual([code, true])
    for (const code of FENCE_PROBES_CLEAN) expect([code, strippingHitsIn(code)]).toEqual([code, []])
  })
})
