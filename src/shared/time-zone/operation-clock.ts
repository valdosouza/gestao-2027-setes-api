import { AsyncLocalStorage } from 'async_hooks'

/**
 * RELÓGIO ÚNICO POR OPERAÇÃO (Q-TZ8, Valdo 2026-09-30 — "siga as recomendações";
 * M1 do gate socrático da onda TZ-1): um faturamento às 23:59:59 lia o relógio a
 * cada `todayFor` (vencimentos, dt_emission, evento E, cheque, estorno) e podia
 * gravar DIAS diferentes na mesma operação. O instante é capturado UMA vez, na
 * entrada da requisição HTTP (middleware em app.ts), e vale para todo "hoje"
 * calculado dentro dela — inclusive nas continuações assíncronas.
 *
 * Só a DATA DE NEGÓCIO usa este relógio. Instante real (dhEmi/dhEvento da NFS-e,
 * created_at) continua sendo o agora de verdade — o fisco não aceita hora futura e
 * um lote longo não pode carimbar o passado como se fosse o envio.
 */
const storage = new AsyncLocalStorage<{ now: Date }>()

/** Executa [fn] com o relógio da operação fixado em [now]. */
export function runWithOperationClock<T>(now: Date, fn: () => T): T {
  return storage.run({ now }, fn)
}

/** Instante da operação corrente (null fora de uma operação — rotina, script, teste). */
export function operationNow(): Date | null {
  return storage.getStore()?.now ?? null
}
