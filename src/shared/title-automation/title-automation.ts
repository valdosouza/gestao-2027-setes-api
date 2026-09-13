import { PoolConnection } from 'mysql2/promise'
import logger from '@shared/logger/logger'
import { runIsolated } from '@shared/db/savepoint'
import { tryAutoSettleByContract } from '@shared/financial-settlement'
import { tryIssueBankSlipsOnBilling } from '@shared/bank-slip'
import { getConfigContentFor } from '@shared/interface-config'

/**
 * COMPOSIÇÃO (não peça): o desfecho que a FORMA DE PAGAMENTO dá à parcela
 * recém-nascida. Fato gerador = o título nascendo do faturamento.
 *
 * Dois desfechos, mutuamente exclusivos por construção (a forma de boleto é
 * `kind='B'`, que a auto-baixa recusa por KIND_FIXED):
 *  - regra de recebimento presente na forma  → o título nasce BAIXADO;
 *  - forma de boleto + 1 carteira ativa + `auto_bank_slip` ligada → nasce com
 *    BOLETO.
 * Sem nenhum dos dois, o título simplesmente fica aberto.
 *
 * Fronteira (para não virar gaveta — parecer do guardião conceitual,
 * 2026-09-13): entram só automatismos decididos pela FORMA, sobre parcelas
 * JÁ GRAVADAS, que NUNCA derrubam a nota. Ficam de fora:
 *  - o CHEQUE: nasce de ato declarado do usuário, é obrigatório e derruba a
 *    nota de propósito (sem caixa aberto não há outro jeito de ele nascer) —
 *    continua chamado direto pelo billing;
 *  - comissão, devolução e status do pedido: fatos do PEDIDO, não da forma;
 *  - emitir a nota e gravar os títulos: a montante — esta composição roda a
 *    jusante e só recebe as parcelas, para que o próximo produtor de títulos
 *    (PDV, compra) a reuse sem alteração.
 */

export interface TitleParcel {
  parcel:        number
  paymentTypeId: number
  /** Valor da parcela — o que a baixa automática credita. */
  amount:        number
}

export interface TitleAutomationInput {
  orderId:  number
  /** Data LOCAL do faturamento (fato gerador — D6/D12 do contrato). */
  dtPayment: string
  parcels:  TitleParcel[]
}

export interface TitleAutomationResult {
  autoSettled:     number
  bankSlipsIssued: number
}

/**
 * Configuração da automação, resolvida ANTES da transação.
 *
 * Por que não a composição lê sozinha lá dentro (como estava na 1ª versão):
 * a leitura vai ao `pool`, isto é, pede uma SEGUNDA conexão enquanto a
 * primeira já segura a transação com os títulos e o lock da institution. Com
 * `connectionLimit: 20` e `waitForConnections: true`, N faturamentos
 * concorrentes com o cache frio prendem as 20 conexões esperando uma 21ª que
 * ninguém vai liberar — o gate adversarial provou o travamento PERMANENTE da
 * API (0 de 40 faturamentos concluídos em 45 s).
 *
 * A composição continua sendo a fonte ÚNICA de QUAL chave governa a automação
 * (o chamador não precisa saber que ela existe nem onde mora) — só que a
 * leitura acontece fora da zona transacional.
 */
export interface TitleAutomationConfig {
  autoBankSlip: boolean
}

/**
 * Data de HOJE no fuso local em 'YYYY-MM-DD'. `toISOString()` seria UTC — à
 * noite em Brasília viraria o dia seguinte e divergiria do CURDATE() que o
 * estorno usa.
 */
export function localIsoDate(now: Date = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * "Emitir boleto automaticamente no faturamento" é config da interface
 * `billing` (seed 48). Chame SEMPRE antes de `beginTransaction`.
 */
export async function resolveTitleAutomationConfig(
  schemaName: string, institutionId: number, userId: number
): Promise<TitleAutomationConfig> {
  return {
    autoBankSlip: (await getConfigContentFor(
      schemaName, institutionId, userId, 'billing', 'auto_bank_slip')) === 'S',
  }
}

export async function applyTitleAutomation(
  conn: PoolConnection, schemaName: string, institutionId: number, userId: number,
  input: TitleAutomationInput, config: TitleAutomationConfig
): Promise<TitleAutomationResult> {
  const result: TitleAutomationResult = { autoSettled: 0, bankSlipsIssued: 0 }

  // Parcela de valor ZERO é resíduo do rateio (0,01 em 3 parcelas → 0/0/0,01),
  // não é cobrança: não há o que baixar nem o que cobrar. Emitir boleto dela
  // derrubava o BLOCO inteiro — `issueBankSlip` recusa título de saldo zero
  // com 409 TITLE_SETTLED, o erro subia pelo savepoint e a ordem acabava SEM
  // boleto nenhum, em silêncio (gate adversarial, achado 4).
  const cobraveis = input.parcels.filter(p => p.amount > 0)
  if (cobraveis.length === 0) return result

  // 1. Baixa automática por CONTRATO FINANCEIRO, parcela a parcela (D1–D22 do
  //    prompt_contrato_financeiro_baixa_automatica.md). A PRESENÇA do contrato
  //    decide; sem contrato o título nasce aberto (regra 4) e NUNCA bloqueia o
  //    faturamento (regra 3): os motivos de negócio voltam graciosos e só
  //    NO_CONTRACT/KIND_FIXED são silêncio — os demais viram aviso, porque
  //    indicam configuração incompleta que alguém precisa ver.
  for (const p of cobraveis) {
    const settled = await runIsolated(
      conn, 'auto_settle', 'Baixa automática por contrato',
      () => tryAutoSettleByContract(conn, schemaName, institutionId, userId, {
        orderId: input.orderId, parcel: p.parcel, paidValue: p.amount,
        dtPayment: input.dtPayment, paymentTypeId: p.paymentTypeId,
      }),
      { institutionId, orderId: input.orderId, parcel: p.parcel }
    )
    if (settled === null) continue      // trecho desfeito: título fica aberto p/ baixa manual
    if (settled.settled) {
      result.autoSettled += 1
    } else if (settled.reason !== 'NO_CONTRACT' && settled.reason !== 'KIND_FIXED') {
      logger.warn('Baixa automática não realizada — título fica aberto p/ baixa manual', {
        institutionId, orderId: input.orderId, parcel: p.parcel, reason: settled.reason,
      })
    }
  }

  // 2. Emissão AUTOMÁTICA de boleto (D18 do regra de recebimento / D9 do
  //    boleto): 1 boleto por parcela de forma kind='B'. 0 ou 2..n carteiras
  //    ativas = nada (a tela de Boletos emite) — a carteira é resolvida uma
  //    vez para o lote de parcelas, não por parcela.
  if (config.autoBankSlip) {
    const issued = await runIsolated(
      conn, 'auto_bank_slip', 'Emissão automática de boleto',
      () => tryIssueBankSlipsOnBilling(conn, schemaName, institutionId, userId, {
        orderId: input.orderId,
        parcels: cobraveis.map(p => ({ parcel: p.parcel, paymentTypeId: p.paymentTypeId })),
      }),
      { institutionId, orderId: input.orderId }
    )
    if (issued?.reason === 'MULTIPLE_AGREEMENTS') {
      logger.warn('Boleto automático não emitido — várias carteiras ativas (emitir na tela de Boletos)', {
        institutionId, orderId: input.orderId,
      })
    }
    result.bankSlipsIssued = issued?.issued ?? 0
  }

  return result
}
