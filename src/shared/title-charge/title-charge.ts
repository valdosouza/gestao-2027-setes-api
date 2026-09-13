import { PoolConnection } from 'mysql2/promise'
import { HttpError } from '@shared/errors/http-error'
import { assertSchema } from '@shared/db/schema'
import { assertPaymentTypesEnabled } from '@shared/payment-types'
import { getPrincipalPaidTx } from '@shared/financial-settlement/title-balance'
import { isValidIsoDate } from '@shared/validation'

/**
 * REDIRECIONAR A COBRANÇA DE UM TÍTULO — apontar, no título vivo, COMO aquela
 * dívida será cobrada daqui para frente (D17, Valdo 2026-09-13: *"é normal que
 * um financeiro tenha uma renegociação... a casa da alteração é no financeiro,
 * faturamento permanece igual"*).
 *
 * Fato gerador: a repactuação — POSTERIOR ao faturamento, sobre a dívida que já
 * existe. `tb_financial` já É a condição vigente de cobrança da parcela
 * (quanto / quando / como): esta peça escreve o "quando" e o "como".
 *
 * **UPDATE simples, não evento** (D18): a negociação ORIGINAL já é imutável em
 * `tb_order_billing` (forma e prazo gravados no ato do faturamento, inclusive no
 * caminho da OS) e `tb_order_installment`. Dinheiro MOVIMENTADO continua
 * append-only; a CONDIÇÃO de cobrança é estado.
 *
 * ⚠️ CONHECIMENTO NEGATIVO — não "conserte" isto virando evento por conta
 * própria: a ausência de rastro (quem redirecionou, quantas vezes) é decisão
 * consciente do Valdo, com o ponto de partida preservado no pedido. No dia em
 * que a pergunta "quantas vezes esta dívida foi renegociada" aparecer, o ato
 * vira FATO e ganha evento — e isso é decisão nova, não remendo.
 *
 * Por que mudar o título NÃO reescreve história: a baixa copia a forma do
 * título PARA O PAGAMENTO no ato (`settlement-batch`), então dinheiro que já
 * entrou carrega a forma congelada. É exatamente por isso que o UPDATE simples
 * não é maquete.
 *
 * A peça NÃO conhece instrumento de cobrança: "título com boleto vigente não
 * pode ser redirecionado" é regra do BOLETO e mora nele — quem compõe as duas
 * é o módulo, para a dependência não inverter (o geral não pode importar o
 * particular).
 *
 * Guardas que morrem POR CONSTRUÇÃO (não vire código):
 *  - "não mexer em título de nota cancelada" → o cancelamento soft-deleta o
 *    título, e o `deleted='N'` do lock já o exclui;
 *  - "não contradizer a negociação original" → a peça não toca as tabelas do
 *    pedido;
 *  - "não disparar baixa automática ao virar forma com regra de recebimento" →
 *    `title-automation` só roda no faturamento, sobre parcela recém-nascida.
 *    Redirecionar NUNCA liquida.
 *
 * E uma que deliberadamente NÃO existe: "só título a receber". O ato é neutro
 * quanto ao sentido — "ia pagar o fornecedor em dinheiro, vou pagar por
 * transferência" é a mesma nuvem. Quem restringe a recebíveis é o boleto.
 */

export interface RetargetTitleChargeInput {
  orderId: number
  parcel:  number
  /** Forma que passa a valer. */
  paymentTypeId: number
  /**
   * Novo vencimento (D19 — a peça escreve a condição INTEIRA desde já; a tela
   * desta onda expõe só a forma). Ausente = vencimento inalterado.
   */
  dtExpiration?: string | null
}

export interface RetargetTitleChargeResult {
  orderId: number
  parcel:  number
  /** Forma anterior — o chamador decide se mostra ("de X para Y"). */
  previousPaymentTypeId: number
  paymentTypeId: number
  dtExpiration: string
  /** false quando nada mudou (redirecionar para a MESMA condição é no-op). */
  changed: boolean
}

export async function retargetTitleCharge(
  conn: PoolConnection, schemaName: string, institutionId: number,
  input: RetargetTitleChargeInput
): Promise<RetargetTitleChargeResult> {
  const s = assertSchema(schemaName)

  if (input.dtExpiration != null && !isValidIsoDate(input.dtExpiration)) {
    throw new HttpError(400, 'Data de vencimento inválida',
      [{ field: 'dtExpiration', message: 'Use YYYY-MM-DD' }], 'VALIDATION_FAILED')
  }

  // Título vivo e TRAVADO antes de qualquer decisão (o saldo é lido depois,
  // já sob o lock — mesma ordem das outras portas do financeiro).
  const [rows] = await conn.query<any[]>(
    `SELECT f.tb_payment_types_id AS paymentTypeId, f.tag_value AS tagValue,
            DATE_FORMAT(f.dt_expiration, '%Y-%m-%d') AS dtExpiration
       FROM \`${s}\`.tb_financial f
      WHERE f.tb_institution_id = ? AND f.tb_order_id = ? AND f.terminal = 0
        AND f.parcel = ? AND f.deleted = 'N' FOR UPDATE`,
    [institutionId, input.orderId, input.parcel]
  )
  if (!rows[0]) {
    throw new HttpError(404, `Título ${input.orderId}/${input.parcel} não encontrado`,
      undefined, 'TITLE_NOT_FOUND')
  }
  const atual = {
    paymentTypeId: Number(rows[0].paymentTypeId),
    dtExpiration:  String(rows[0].dtExpiration ?? ''),
  }

  // Saldo pela peça ÚNICA (nunca uma fórmula nova — Q-G21/D-G28): dívida já
  // quitada não se redireciona, porque não há mais o que cobrar.
  const principalPago = await getPrincipalPaidTx(
    conn, s, institutionId, input.orderId, input.parcel)
  if (principalPago >= Number(rows[0].tagValue)) {
    throw new HttpError(409,
      `Título ${input.orderId}/${input.parcel} já está quitado — não há cobrança a redirecionar`,
      undefined, 'TITLE_SETTLED')
  }

  // Forma vinculada e HABILITADA na institution (peça única — 400
  // PAYMENT_TYPE_UNAVAILABLE, igual às três portas do faturamento).
  await assertPaymentTypesEnabled(
    conn, s, institutionId, [input.paymentTypeId], 'paymentTypeId')

  const novoVencimento = input.dtExpiration ?? atual.dtExpiration
  const changed = input.paymentTypeId !== atual.paymentTypeId
               || novoVencimento !== atual.dtExpiration

  if (changed) {
    await conn.query(
      `UPDATE \`${s}\`.tb_financial
          SET tb_payment_types_id = ?, dt_expiration = ?, updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
          AND parcel = ? AND deleted = 'N'`,
      [input.paymentTypeId, novoVencimento, institutionId, input.orderId, input.parcel]
    )
  }

  return {
    orderId: input.orderId, parcel: input.parcel,
    previousPaymentTypeId: atual.paymentTypeId,
    paymentTypeId: input.paymentTypeId,
    dtExpiration: novoVencimento,
    changed,
  }
}
