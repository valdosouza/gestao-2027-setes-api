/**
 * Mensagens da recusa do LOTE por condição de cobrança ausente (D13/D14/D23).
 *
 * Módulo próprio (sem dependência de banco) para as DUAS portas — a leitura
 * antecipada do service e a reconferência dentro da transação do repositório
 * (M1 do gate socrático da Rodada 5) — dizerem exatamente a mesma coisa, e para
 * os testes que mockam o repositório inteiro continuarem vendo o texto real.
 *
 * M2 do gate socrático + achado 1 do adversarial (Rodada 5, 2026-09-19): sob a
 * D23 "acerte o contrato" NÃO resolve o mês já injetado — o contrato editado só
 * governa meses futuros, e o fato congelado é imutável por decisão. Um contrato
 * editado entre dois meses NÃO faturados deixa fatos DIVERGENTES na mesma OS; a
 * saída real é informar a condição no lote, remover o item (D-A34 libera a
 * competência) ou cancelar a OS e rodar a cobrança de novo. A OS AVULSA (nenhum
 * fato) é outro beco: não há contrato a culpar — só o lote pode dizer.
 */
export const ORDER_NO_CONTRACT_DUE_DAY_MSG =
  'Competências desta ordem sem dia de vencimento único (contratos divergem ou foram editados entre os meses) — '
  + 'informe o vencimento do lote; editar o contrato só vale para meses futuros (para estes, remova o item ou cancele a OS e rode a cobrança de novo)'

export const ORDER_NO_CONTRACT_PAYMENT_TYPE_MSG =
  'Competências desta ordem sem forma de pagamento única combinada (contratos divergem, sem forma ou editados entre os meses) — '
  + 'informe a forma do lote; editar o contrato só vale para meses futuros (para estes, remova o item ou cancele a OS e rode a cobrança de novo)'

export const ORDER_STANDALONE_DUE_DAY_MSG =
  'Ordem avulsa, sem competência de contrato — informe o vencimento do lote (ou fature pela ordem, com as condições)'

export const ORDER_STANDALONE_PAYMENT_TYPE_MSG =
  'Ordem avulsa, sem competência de contrato — informe a forma de pagamento do lote (ou fature pela ordem, com as condições)'
