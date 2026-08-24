/**
 * Motor de observações fiscais (T6/P11 do tributacao.md) — evidência linha a
 * linha de `Pc_Obs_NotaFiscal`/`Pc_Obs_CSTxx`/`Pc_Obs_CSOSNxxx`
 * (tributacao.pas:4185-5432). "Regra 5" do mapeamento: as ~20 rotinas quase
 * idênticas do legado colapsam em UMA tabela declarativa por grupo — o
 * conteúdo é dado, não código.
 *
 * 3 bugs comprovados do legado CORRIGIDOS aqui (decisão do Valdo,
 * rodada Observações 2026-08-22):
 * - CST 80 no legado é um procedimento VAZIO (não gera observação); não
 *   existe CST 80 no nosso domínio (`calc.ts`), então nunca é dispatchado —
 *   nada a corrigir na prática.
 * - CSOSN 400 no legado nunca dispara (falta o bind de OBS_CODMHA no SQL —
 *   filtra por NULL sempre); aqui filtra corretamente pelo estabelecimento.
 * - CSOSN 201 no legado tem substituição de placeholder quebrada (a base/
 *   valor do ST são calculados mas nunca chegam ao texto — os tokens já
 *   foram consumidos por uma rodada anterior); aqui usa os 4 campos que o
 *   comentário do próprio código-fonte já sugeria: base ST, valor ST,
 *   alíquota do crédito, valor do crédito.
 *
 * "Só a 1ª observação distinta por grupo" quando há mais de uma cadastrada
 * é MANTIDO fielmente (decisão do Valdo — paridade; é o padrão em ~10 das
 * ~19 rotinas mesmo nas que agregam valores).
 *
 * GAP registrado (fora desta rodada): CST 60/70 dependem do rastreio de ST
 * retido (`Pc_ControleRastreioICMSST`, P2.8) — explicitamente fora do
 * escopo do motor de cálculo (`calc.ts`, comentário do CST 60). Sem esse
 * rastreio não há campo `withheld_*` confiável para alimentar o texto —
 * esses dois grupos ficam SEM observação regime-específica até a frente do
 * rastreio de ST ser implementada (mesmo padrão de "sem silêncio": a nota
 * fatura normalmente, só não ganha essa observação em particular).
 */

export interface ObsRegimeItem {
  cst: string | null            // código do grupo — CST ou CSOSN (mesma coluna persistida)
  baseSt?: number | null
  valueSt?: number | null
  baseReduction?: number | null // TRB_RD_BS_ICMS — usado como "1&v" bruto do CST 20 (melhor leitura do achado ICM_AQ_RD_BC_NR)
  creditAliq?: number | null
  creditValue?: number | null
  observationNote: string | null
}

type PlaceholderKind = 'sum' | 'raw' | 'config'

interface PlaceholderSpec {
  token: string
  kind: PlaceholderKind
  field?: (i: ObsRegimeItem) => number | null | undefined
}

interface GroupSpec {
  placeholders: PlaceholderSpec[]
}

/**
 * Chave única (códigos CST e CSOSN nunca colidem numericamente — 2 dígitos
 * vs 3), então um único dispatch table cobre os dois regimes.
 */
const REGIME_GROUPS: Record<string, GroupSpec> = {
  // ── CST (regime normal) ──
  '00': { placeholders: [] },
  '10': { placeholders: [
    { token: '1&v', kind: 'sum', field: i => i.baseSt },
    { token: '2&v', kind: 'sum', field: i => i.valueSt },
  ] },
  '20': { placeholders: [
    { token: '1&v', kind: 'raw', field: i => i.baseReduction },
  ] },
  '30': { placeholders: [
    { token: '1&v', kind: 'sum', field: i => i.baseSt },
    { token: '2&v', kind: 'sum', field: i => i.valueSt },
  ] },
  '40': { placeholders: [] },
  '41': { placeholders: [] },
  '50': { placeholders: [] },
  '51': { placeholders: [] },
  '90': { placeholders: [] },
  // 60/70 fora — dependem do rastreio de ST retido (P2.8, gap acima)

  // ── CSOSN (Simples Nacional) ──
  '101': { placeholders: [
    { token: '1&v', kind: 'sum', field: i => i.creditValue },
    { token: '2&v', kind: 'config' },
  ] },
  '102': { placeholders: [] },
  '103': { placeholders: [] },
  '201': { placeholders: [ // CORRIGIDO (decisão do Valdo) — bug do legado
    { token: '1&v', kind: 'sum', field: i => i.baseSt },
    { token: '2&v', kind: 'sum', field: i => i.valueSt },
    { token: '3&v', kind: 'config' },
    { token: '4&v', kind: 'sum', field: i => i.creditValue },
  ] },
  '202': { placeholders: [
    { token: '1&v', kind: 'sum', field: i => i.baseSt },
    { token: '2&v', kind: 'sum', field: i => i.valueSt },
  ] },
  '203': { placeholders: [] },
  '300': { placeholders: [] },
  '400': { placeholders: [] }, // CORRIGIDO — bug de bind do legado (nunca disparava)
  '500': { placeholders: [] },
  '900': { placeholders: [] },
}

function formatObsNumber(v: number): string {
  return (Math.round((v + Number.EPSILON) * 100) / 100).toFixed(2).replace('.', ',')
}

/**
 * Monta o texto de cada grupo (CST/CSOSN) presente entre os itens da nota,
 * SÓ para itens com regra vinculada a uma observação (`tb_observation` via
 * `tb_tax_rule.tb_observation_id`). Paridade com o legado: quando há mais
 * de um texto distinto cadastrado pro mesmo grupo, usa só o PRIMEIRO
 * encontrado — e os placeholders agregam SÓ os itens que compartilham
 * esse texto (replica o `GROUP BY OBS_DETALHES` + "lê só a 1ª linha").
 */
export function buildRegimeObservations(
  items: ObsRegimeItem[], creditAliqPct: number
): string[] {
  const firstTextByCode = new Map<string, string>()
  const itemsByCode = new Map<string, ObsRegimeItem[]>()
  const codeOrder: string[] = []

  for (const item of items) {
    if (!item.cst || !item.observationNote) continue
    const spec = REGIME_GROUPS[item.cst]
    if (!spec) continue

    if (!firstTextByCode.has(item.cst)) {
      firstTextByCode.set(item.cst, item.observationNote)
    }
    if (item.observationNote !== firstTextByCode.get(item.cst)) continue

    if (!itemsByCode.has(item.cst)) {
      itemsByCode.set(item.cst, [])
      codeOrder.push(item.cst)
    }
    itemsByCode.get(item.cst)!.push(item)
  }

  return codeOrder.map((code) => {
    const spec = REGIME_GROUPS[code]
    const groupItems = itemsByCode.get(code)!
    let text = groupItems[0].observationNote!
    for (const ph of spec.placeholders) {
      const value = ph.kind === 'config'
        ? creditAliqPct
        : ph.kind === 'raw'
          ? (ph.field!(groupItems[0]) ?? 0)
          : groupItems.reduce((sum, i) => sum + (ph.field!(i) ?? 0), 0)
      text = text.split(ph.token).join(formatObsNumber(value))
    }
    return text
  })
}

/**
 * `Pc_Obs_ISSQN` (:5250) — texto fixo (não vem do cadastro de observação),
 * dispara quando há valor de ISSQN retido/substituto tributário na nota.
 */
export function buildIssqnObservation(totalWithheld: number): string | null {
  if (totalWithheld <= 0) return null
  return `Valor do ISSQN retido/Substituto Tributário: R$ ${formatObsNumber(totalWithheld)}`
}

export interface ApproxTaxNcmRate {
  aliqNac: number
  aliqImp: number
  aliqEst: number
  aliqMun: number
}

/**
 * Percentual TOTAL aproximado do item (`ITF_IMP_APROX` do legado) — nac ou
 * imp conforme a origem da mercadoria, + estadual + municipal. Persistido
 * por item (decisão do Valdo) independente da config `approx_tax_enabled`
 * — o legado grava esse campo sempre que o item entra no pedido.
 */
export function calcApproxTaxAliq(originIsImported: boolean, rate: ApproxTaxNcmRate | null): number {
  if (!rate) return 0
  const nac = originIsImported ? rate.aliqImp : rate.aliqNac
  return Math.round((nac + rate.aliqEst + rate.aliqMun) * 10000) / 10000
}

/**
 * `Fc_Obs_ImpostoAproximado` (:5283) — média ponderada pelo valor da
 * mercadoria, um bloco de texto por esfera (só se o valor da esfera > 0),
 * concatenados sem separador (cada bloco além do 1º já começa com "| ").
 * Só roda quando a config `approx_tax_enabled='S'` E a ordem é uma VENDA
 * (equivalente ao "natureza contém 'VENDA'" do legado) — gate fica no
 * chamador, esta função é pura.
 */
export function buildApproxTaxObservation(
  items: { merchandiseValue: number; aliqNac: number; aliqEst: number; aliqMun: number }[]
): string | null {
  const totalBase = items.reduce((sum, i) => sum + i.merchandiseValue, 0)
  if (totalBase <= 0) return null

  let vNac = 0, vEst = 0, vMun = 0
  for (const i of items) {
    vNac += i.merchandiseValue * (i.aliqNac / 100)
    vEst += i.merchandiseValue * (i.aliqEst / 100)
    vMun += i.merchandiseValue * (i.aliqMun / 100)
  }
  const pct = (v: number) => Math.round((v / totalBase) * 10000) / 10000 * 100

  const parts: string[] = []
  if (vNac > 0) parts.push(`Valor aprox Imp. Nacional R$ ${formatObsNumber(vNac)} (${formatObsNumber(pct(vNac))})%`)
  if (vEst > 0) parts.push(`| Imp. Estadual R$ ${formatObsNumber(vEst)} (${formatObsNumber(pct(vEst))})%`)
  if (vMun > 0) parts.push(`| Imp. Municipal R$ ${formatObsNumber(vMun)} (${formatObsNumber(pct(vMun))})%`)
  return parts.length > 0 ? parts.join('') : null
}
