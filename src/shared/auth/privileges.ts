/**
 * Privilégios canônicos do catálogo (tb_privilege — seed da casa, ids
 * estáveis desde o gestão desktop). Definições do Valdo (2026-07-12):
 * VISUALIZAR decide o que entra no MENU do usuário regular (opção 1 do
 * workflow); os demais ligam/desligam ações nas telas (decisão 21 Fase 1).
 */
export const PRIVILEGE_INSERIR    = 1
export const PRIVILEGE_ALTERAR    = 2
export const PRIVILEGE_EXCLUIR    = 3
export const PRIVILEGE_IMPRIMIR   = 4
export const PRIVILEGE_FATURAR    = 5
export const PRIVILEGE_VISUALIZAR = 6
/** Cancelar nota (D12 do cancelamento, 2026-09-08 — seed sql/51; aplicado na
 *  rota pelo guard @shared/auth/require-privilege, junto com FATURAR — Q-P5). */
export const PRIVILEGE_CANCELAR   = 7
/** Desconto na baixa acima do teto da institution (D-G32 do cancelamento, Valdo
 *  2026-09-13 — BX-15 do legado exigia senha para QUALQUER desconto; seed sql/55:
 *  privilégio 8 na interface `settlements` + config `max_discount_aliquot`). */
export const PRIVILEGE_DESCONTO   = 8
/** Transmitir o documento ao FISCO (D-E14 / Onda 3 NFS-e, Valdo 2026-09-21 — seed
 *  sql/59: privilégio 9 nas interfaces `service-orders` e `orders`; exigido em
 *  `POST /api/billing/transmit` pelo ramo do pedido). Separado de FATURAR, como o
 *  legado separava AUTORIZAR. */
export const PRIVILEGE_TRANSMITIR = 9
/** Criar marca/unidade/embalagem no catálogo CENTRAL (D-PR33, branch `merchandise` — seed 66). Reservado aqui para a
 *  numeração dos verbos seguintes; o consumidor vive naquela branch. */
export const PRIVILEGE_CATALOGAR  = 10
/** CONFIGURAR (D-PV25, Valdo 2026-10-20 — seed 68): "pode ajustar o comportamento desta tela" — gravar o valor da
 *  INSTITUTION ('I') de uma config e o required/caption/mask de um campo da tela X exige CONFIGURAR em X, por qualquer
 *  caminho (engrenagem ou painel solto). O override PESSOAL ('U') segue aberto (A-PV6). O par existe para toda interface
 *  com config ou campo no catálogo; "Configurações Gerais" = CONFIGURAR em `general-configs`. */
export const PRIVILEGE_CONFIGURAR = 11
/** CONSULTAR (D-PV40, Valdo 2026-10-20 — seed 68): perguntar ao TERCEIRO (banco, fisco) a situação de um documento sem
 *  mudar estado nele (boleto `refresh`; nfse-api `refresh`; passada do rodízio). TRANSMITIR fica para o que MUDA estado no
 *  terceiro (registrar, transmitir, simular no sandbox). Princípio D-PV27: o verbo nomeia a FINALIDADE, nunca o transporte. */
export const PRIVILEGE_CONSULTAR  = 12
