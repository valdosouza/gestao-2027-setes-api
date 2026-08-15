/**
 * CATÁLOGO DE ERROS CONHECIDOS (decisão R8 do Framework de Mensagens,
 * Alertas e Validação — prompt_framework_mensagens_validacao.md,
 * Valdo 2026-07-19). FONTE DA VERDADE: este arquivo — o código do erro
 * nasce no MESMO commit do throw que o dispara (impossível dessincronizar).
 * A tabela de referência setes_central.tb_error_catalog é DERIVADA daqui
 * por `npm run errors:gen` (nunca editada à mão) para permitir joins SQL
 * com a tb_crashlytics ("quantos ORDER_INVOICED esse mês?").
 *
 * Uso: `throw new HttpError(409, msg, fields, ErrorCodes.ORDER_INVOICED)`.
 * O envelope de erro vira `{ error, code?, ref?, fields? }`.
 */

export const ErrorCodes = {
  // Infra/contrato
  INTERNAL:            'INTERNAL',
  VALIDATION_FAILED:   'VALIDATION_FAILED',
  INVALID_ID:          'INVALID_ID',
  REQUIRED_FIELDS:     'REQUIRED_FIELDS',
  CONFLICT_RETRY:      'CONFLICT_RETRY',
  NOT_FOUND:           'NOT_FOUND',
  // Cadastros / cadeia fiscal
  DUP_DOCUMENT:        'DUP_DOCUMENT',
  DUP_ROLE:            'DUP_ROLE',
  ROLE_MISSING:        'ROLE_MISSING',
  // Árvores (categories/financial-plans)
  PARENT_NOT_FOUND:    'PARENT_NOT_FOUND',
  HAS_CHILDREN:        'HAS_CHILDREN',
  TREE_CYCLE:          'TREE_CYCLE',
  // Software House — ciclo de serviços
  ORDER_OPEN_EXISTS:   'ORDER_OPEN_EXISTS',
  ORDER_INVOICED:      'ORDER_INVOICED',
  ORDER_NO_ITEMS:      'ORDER_NO_ITEMS',
  PAYMENT_TYPE_UNAVAILABLE: 'PAYMENT_TYPE_UNAVAILABLE',
  // Financeiro
  TITLE_NOT_FOUND:     'TITLE_NOT_FOUND',
  BANK_NOT_FOUND:      'BANK_NOT_FOUND',
  BANK_IN_USE:         'BANK_IN_USE',
  REVERSAL_NOT_CURRENT: 'REVERSAL_NOT_CURRENT',
  // Parcerias
  RATE_SUM_EXCEEDED:   'RATE_SUM_EXCEEDED',
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

/** Descrições p/ a tabela derivada (errors:gen) e docs — PT (produto). */
export const ErrorCatalog: Record<ErrorCode, string> = {
  INTERNAL:            'Erro interno do servidor (rastreável pelo ref na tb_crashlytics)',
  VALIDATION_FAILED:   'Payload rejeitado pela validação de formato (Zod) — fields[] aponta os campos',
  INVALID_ID:          'Identificador de rota inválido',
  REQUIRED_FIELDS:     'Campos obrigatórios (configuração do cliente) não preenchidos',
  CONFLICT_RETRY:      'Corrida de cadastro simultâneo detectada — tentar novamente',
  NOT_FOUND:           'Registro não encontrado no escopo do usuário',
  DUP_DOCUMENT:        'CPF/CNPJ/schema já cadastrado em outro registro',
  DUP_ROLE:            'A entidade já tem este papel nesta institution (fields[0] = id existente)',
  ROLE_MISSING:        'Entidade sem o papel necessário nesta institution',
  PARENT_NOT_FOUND:    'Nível superior inexistente na árvore',
  HAS_CHILDREN:        'Registro tem subníveis vivos — exclusão bloqueada',
  TREE_CYCLE:          'Movimento criaria ciclo na árvore',
  ORDER_OPEN_EXISTS:   'Cliente já tem ordem de serviço aberta (D5 — máx. 1)',
  ORDER_INVOICED:      'Ordem já faturada — alterações só via financeiro',
  ORDER_NO_ITEMS:      'Ordem sem itens — nada a faturar',
  PAYMENT_TYPE_UNAVAILABLE: 'Forma de pagamento não vinculada/habilitada na institution',
  TITLE_NOT_FOUND:     'Título financeiro não encontrado',
  BANK_NOT_FOUND:      'Banco/conta bancária inexistente',
  BANK_IN_USE:         'Banco do catálogo em uso por conta corrente de cliente — exclusão bloqueada',
  REVERSAL_NOT_CURRENT: 'Só baixas vigentes (status N) podem ser estornadas',
  RATE_SUM_EXCEEDED:   'Soma dos percentuais de parceria passa de 90% (10% são da Setes)',
}
