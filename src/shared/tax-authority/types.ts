/**
 * Tipos da peça @shared/tax-authority — o TRANSPORTE fiscal (Onda 3 da fase
 * Primeiro Cliente, prompt_onda3_nfse_adn.md §3 "Composições"). A peça NÃO
 * conhece nota: recebe XML já montado/assinado, fala com o fisco sob mTLS e
 * devolve fatos crus. Quem interpreta (S/A/R/C/K/F, efeitos na nota) é a
 * composição @shared/invoice-transmission, de outra etapa.
 *
 * Fonte dos nomes: XSD v1.01 (tiposComplexos/tiposSimples/tiposEventos) e o
 * Manual do Contribuinte v1.2 em Infra-IA/setes-api/integracoes/nfse-adn/.
 */

/** H = produção restrita (tpAmb 2) · P = produção (tpAmb 1) — D-N6/D-N12. */
export type AuthorityEnvironment = 'H' | 'P'

/** Contexto de UMA chamada: par PEM lido do cofre (nunca sai da peça). */
export interface AuthorityContext {
  environment: AuthorityEnvironment
  cert: Buffer            // PEM (certificado do e-CNPJ A1)
  key:  Buffer            // PEM (chave privada correspondente)
}

// ---------------------------------------------------------------------------
// DPS v1.01 — só o subconjunto do caso "prestador PJ, tomador PJ/PF, UM
// serviço, ISS tributável, sem IBS/CBS, sem dedução". A ORDEM dos elementos
// no XML segue TCInfDPS; a obrigatoriedade segue o XSD (não a tela).
// ---------------------------------------------------------------------------

/** TCRegTrib: opSimpNac 1 não optante · 2 MEI · 3 ME/EPP; regEspTrib 0 nenhum … 6. */
export interface DpsRegTrib {
  opSimpNac:    '1' | '2' | '3'
  regApTribSN?: '1' | '2' | '3'
  regEspTrib:   '0' | '1' | '2' | '3' | '4' | '5' | '6'
}

/** TCInfoPrestador (caso PJ): CNPJ + IM opcional + regime. */
export interface DpsPrest {
  cnpj:    string          // 14 dígitos
  im?:     string          // inscrição municipal (≤ 15)
  regTrib: DpsRegTrib
}

/** TCEndereco com endNac (cMun IBGE 7 + CEP 8). */
export interface DpsEndNac {
  cMun:     string
  cep:      string         // 8 dígitos
  xLgr:     string
  nro:      string
  xCpl?:    string
  xBairro:  string
}

/** TCInfoPessoa (tomador): CNPJ ou CPF (exclusivos); `end` é opcional no XSD. */
export interface DpsToma {
  cnpj?:  string
  cpf?:   string
  xNome:  string
  im?:    string
  end?:   DpsEndNac
  fone?:  string           // 6–20 dígitos
  email?: string
}

/** TCServ: local da prestação + código do serviço (UM serviço por DPS — D-N2). */
export interface DpsServ {
  locPrest: { cLocPrestacao: string }         // IBGE 7
  cServ: {
    cTribNac:   string                        // 6 dígitos (Anexo B)
    cTribMun?:  string                        // 3 dígitos
    xDescServ:  string                        // ≤ 2000, aceita quebra de linha
    cNBS?:      string                        // 9 dígitos
  }
  infoCompl?: { docRef?: string; xPed?: string; xInfComp?: string }
}

/** TCTribTotal é um choice: indicador "0" OU percentual do Simples. */
export type DpsTotTrib = { indTotTrib: '0' } | { pTotTribSN: number }

/** TCInfoValores (sem vDedRed): serviço, descontos, ISS municipal, total de tributos. */
export interface DpsValores {
  vServ:        number
  vDescIncond?: number
  vDescCond?:   number
  trib: {
    tribMun: {
      tribISSQN:  '1' | '2' | '3' | '4'       // 1 tributável · 2 imune · 3 exportação · 4 não incidência
      tpRetISSQN: '1' | '2' | '3'             // 1 não retido · 2 retido pelo tomador · 3 pelo intermediário
      pAliq?:     number                      // TSDec1V2: 0–9.99 (%)
    }
    totTrib: DpsTotTrib
  }
}

export interface DpsInput {
  environment: AuthorityEnvironment           // vira tpAmb (H→2, P→1)
  dhEmi:       string                         // ISO com fuso; normalizado para AAAA-MM-DDThh:mm:ss±hh:00
  verAplic:    string                         // 1–20
  serie:       number | string                // 1..49999 (aplicativo próprio)
  nDps:        number | string                // 1..999999999999999
  dCompet:     string                         // AAAA-MM-DD
  tpEmit:      '1'                            // só prestador (2/3 rejeitados — E9996)
  cLocEmi:     string                         // IBGE 7
  prest:       DpsPrest
  toma?:       DpsToma
  serv:        DpsServ
  valores:     DpsValores
}

/** Tipo de inscrição no Id do DPS/chave: 1 CPF · 2 CNPJ (manual v1.2 §1.4.1). */
export type DpsTpInsc = '1' | '2'

// ---------------------------------------------------------------------------
// Pedido de registro de evento (pedRegEvento v1.01) — só o cancelamento e101101.
// ---------------------------------------------------------------------------

export interface CancelEventInput {
  accessKey:    string                        // chave de 50 dígitos
  dhEvento:     string                        // ISO com fuso
  cMotivo:      '1' | '2' | '9'               // 1 erro na emissão · 2 serviço não prestado · 9 outros
  xMotivo:      string                        // 15–255
  environment:  AuthorityEnvironment
  verAplic:     string
  /** Autor: CNPJ (PJ) OU CPF (PF) — choice do XSD, exatamente um. */
  cnpjAutor?:   string
  cpfAutor?:    string
}

// ---------------------------------------------------------------------------
// Leituras dos XML do fisco (NFS-e e Evento).
// ---------------------------------------------------------------------------

export interface ParsedNfse {
  accessKey:  string | null                   // infNFSe/@Id sem o literal "NFS"
  nNFSe:      string | null
  dhProc:     string | null
  cStat:      string | null                   // 100 gerada · 102 decisão judicial · 103 avulsa · 107 MEI (NÃO é cancelamento)
  nDFSe:      string | null
  ambGer:     string | null
  dpsId:      string | null                   // infDPS/@Id embutido na NFS-e
  /** Presente só se o texto trouxer um e101101 junto (respostas agregadas). */
  cancelled:  { dhEvento: string | null; cMotivo: string | null; xMotivo: string | null } | null
}

export interface ParsedEvent {
  eventId:    string | null                   // infEvento/@Id (EVT + 59) — só no evento gerado pelo fisco
  pedRegId:   string | null                   // infPedReg/@Id (PRE + 56)
  eventCode:  string | null                   // "101101" etc. (do elemento e######)
  accessKey:  string | null                   // chNFSe
  dhEvento:   string | null                   // infPedReg/dhEvento
  dhProc:     string | null                   // infEvento/dhProc (voz do fisco)
  nSeqEvento: string | null
  cMotivo:    string | null
  xMotivo:    string | null
}

// ---------------------------------------------------------------------------
// Vocabulário do adaptador (fatos crus; a composição decide S/A/R/C/K/F).
// ---------------------------------------------------------------------------

export interface TransmitResult {
  accessKey:  string
  nfseNumber: string | null
  dhProc:     string | null
  /** NFS-e autorizada, XML já descomprimido (o envelope traz GZip+Base64). */
  nfseXml:    string
  /** Envelope JSON como veio (alertas, idDps…) — a composição guarda o que quiser. */
  raw:        unknown
}

/** Um item de rejeição do fisco: código E0xxx + mensagem. */
export interface AuthorityRejection { code: string; message: string }

export interface NfseQuery {
  accessKey:  string
  status:     'authorized' | 'cancelled' | 'unknown'
  nfseXml:    string
  dhProc:     string | null
  cancelled?: { dhEvento: string | null; motive: string | null }
}

export interface EventRegisterResult {
  dhEvento:  string | null
  protocol?: string | null                    // Id do evento gerado (EVT…) quando o fisco o devolve
  raw:       unknown
}

export interface MunicipalTerms {
  /** Prazo de cancelamento em dias quando o JSON do convênio o traz; null = não achei (D-N15). */
  cancelDays: number | null
  raw:        unknown
}

export type TaxAuthority = 'ADN'

/** Contrato do adaptador de uma autoridade fiscal (dialeto). */
export interface TaxAuthorityAdapter {
  readonly authority: TaxAuthority
  transmit(ctx: AuthorityContext, signedDpsXml: string): Promise<TransmitResult>
  queryNfse(ctx: AuthorityContext, accessKey: string): Promise<NfseQuery>
  /** GET /dps/{id} → chave de acesso; 404 = ainda não existe NFS-e para esse DPS (null). */
  queryDpsAccessKey(ctx: AuthorityContext, dpsId: string): Promise<string | null>
  registerEvent(ctx: AuthorityContext, accessKey: string, signedEventXml: string): Promise<EventRegisterResult>
  municipalTerms(ctx: AuthorityContext, cMun: string): Promise<MunicipalTerms>
}
