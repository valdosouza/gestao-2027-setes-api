/**
 * Tipos da peça @shared/bank-channel — o CANAL API de uma conta corrente com o
 * seu banco (Onda 2 da fase Primeiro Cliente, D-I2…D-I15). A peça não conhece
 * boleto: fala em "cobrança" no vocabulário do banco e devolve fatos crus; quem
 * interpreta é a composição @shared/bank-slip-registration.
 */

export type ChannelEnvironment = 'S' | 'P'

export interface BankChannelRow {
  bankAccountId:   number
  institutionId:   number
  environment:     ChannelEnvironment
  clientId:        string | null
  inboundToken:    string
  active:          'S' | 'N'
  /** Derivados da CONTA (D-I2/D-I14): número FEBRABAN do banco e conta corrente. */
  bankNumber:      string
  accountNumber:   string | null
  accountNumberDv: string | null
}

export interface BankChannelInput {
  environment: ChannelEnvironment
  clientId:    string | null
  active:      'S' | 'N'
}

/** Segredos lidos do cofre para UMA chamada — nunca saem da peça. */
export interface ChannelSecrets {
  cert:         Buffer
  key:          Buffer
  clientSecret: string
}

/** Situação do certificado/segredos para a tela (só metadados públicos). */
export interface ChannelSecretsStatus {
  certificate:  boolean
  privateKey:   boolean
  clientSecret: boolean
  certificateInfo: {
    subject: string; issuer: string; notAfter: string; daysToExpire: number; expired: boolean
  } | null
}

// ---------------------------------------------------------------------------
// Vocabulário do banco (cobrança) — o adaptador traduz o dialeto do banco para
// isto; a composição traduz isto para eventos do boleto.
// ---------------------------------------------------------------------------

export interface ChargePayer {
  document:     string          // CPF/CNPJ só dígitos
  personType:   'F' | 'J'
  name:         string
  street:       string          // endereço (logradouro + número)
  neighborhood: string | null
  city:         string
  state:        string          // UF
  zipCode:      string          // 8 dígitos
}

export interface ChargeRegisterInput {
  /** Nossa referência (seuNumero) — ≤ 15 caracteres. */
  reference:    string
  amount:       number
  dueDate:      string          // YYYY-MM-DD
  payer:        ChargePayer
  messages?:    string[]        // até 5 linhas ≤ 78
  /** Multa por atraso (% do valor) e mora (% ao mês) — opcionais. */
  finePercent?:     number | null
  interestMonthly?: number | null
  /** Desconto até N dias antes do vencimento (% do valor). */
  discountPercent?: number | null
  discountDays?:    number | null
}

export interface ChargeStatus {
  requestCode:    string
  reference:      string | null
  /** Situação CRUA como o banco escreveu. */
  status:         string
  /** Data/hora da situação, ISO (date ou date-time) — pode faltar. */
  statusAt:       string | null
  amount:         number | null
  paidValue:      number | null
  paidBy:         'BOLETO' | 'PIX' | null
  bankOurNumber:  string | null
  digitableLine:  string | null
  barcode:        string | null
  pixCopyPaste:   string | null
  pixTxid:        string | null
  cancelReason:   string | null
}

export interface WebhookInfo { url: string; createdAt: string | null; updatedAt: string | null }

export interface AdapterContext {
  channel: BankChannelRow
  secrets: ChannelSecrets
}

/** Contrato do adaptador de um banco (dialeto). Registro por número FEBRABAN. */
export interface BankChargeAdapter {
  readonly bankNumber: string
  register(ctx: AdapterContext, input: ChargeRegisterInput): Promise<{ requestCode: string }>
  query(ctx: AdapterContext, requestCode: string): Promise<ChargeStatus>
  cancel(ctx: AdapterContext, requestCode: string, reason: string): Promise<void>
  pdf(ctx: AdapterContext, requestCode: string): Promise<Buffer>
  /** Reconciliação de órfãos (D-I13): cobranças do banco pela nossa referência. */
  findByReference(ctx: AdapterContext, reference: string, from: string, to: string): Promise<ChargeStatus[]>
  webhookGet(ctx: AdapterContext): Promise<WebhookInfo | null>
  webhookPut(ctx: AdapterContext, url: string): Promise<void>
  webhookDelete(ctx: AdapterContext): Promise<void>
  /** Só sandbox: simula o pagamento (prova do critério 2 sem dinheiro real). */
  paySandbox(ctx: AdapterContext, requestCode: string, via: 'BOLETO' | 'PIX'): Promise<void>
}
