/**
 * Funções PURAS do ciclo mensal de serviços (Fase 3 do doc
 * 05-ORDEM-SERVICO-SOFTWARE-HOUSE.md) — sem SQL, testáveis isoladamente.
 * Datas em 'YYYY-MM-DD' (comparação lexicográfica é segura no formato).
 */

/** Último dia do mês da competência ('YYYY-MM-DD'). */
export function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Primeiro dia do mês da competência ('YYYY-MM-DD'). */
export function firstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

function dayOf(date: string): number {
  return Number(date.slice(8, 10))
}

/**
 * Pró-rata 30 dias corridos (D2/D3): valor mensal proporcional aos dias
 * ATIVOS do contrato dentro da competência — início no meio do mês
 * (cliente novo) e/ou fim no meio do mês (cancelado, faturamento parcial).
 * Contrato cobrindo o mês inteiro devolve o valor cheio.
 */
export function prorataValue(
  monthlyValue: number, dtStart: string, dtEnd: string | null,
  year: number, month: number
): number {
  const first = firstDayOfMonth(year, month)
  const last  = lastDayOfMonth(year, month)

  const from = dtStart > first ? dtStart : first
  const to   = dtEnd != null && dtEnd < last ? dtEnd : last
  if (from > to) return 0

  if (from === first && to === last) return round2(monthlyValue)

  const days = dayOf(to) - dayOf(from) + 1
  return round2(monthlyValue * Math.min(days, 30) / 30)
}

/** Quotas das parcelas: round(total/n) com o RESÍDUO de centavos na última. */
export function parcelQuotas(total: number, parcels: number): number[] {
  const base = round2(total / parcels)
  const quotas = Array.from({ length: parcels }, () => base)
  const spread = round2(base * (parcels - 1))
  quotas[parcels - 1] = round2(total - spread)
  return quotas
}

/**
 * SUGESTÃO de vencimento (DP1 revisada — o USUÁRIO decide na tela; isto é
 * só o default): 5º dia útil seg–sex do mês SEGUINTE à competência.
 */
export function fifthBusinessDaySuggestion(year: number, month: number): string {
  let y = year, m = month + 1
  if (m > 12) { m = 1; y += 1 }
  let count = 0
  for (let day = 1; day <= 31; day++) {
    const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay()
    if (weekday >= 1 && weekday <= 5) count += 1
    if (count === 5) {
      return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  return `${y}-${String(m).padStart(2, '0')}-07`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
