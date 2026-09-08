-- 038 — Contrato financeiro: POLÍTICA de baixa automática por forma de
-- pagamento (Infra-IA/prompts/prompt_contrato_financeiro_baixa_automatica.md,
-- D1–D22 — Valdo, 2026-09-03). Evolução do TB_CARTAOELETRONICO do legado.
--
-- O contrato é ESPECIALIZAÇÃO do vínculo institution × forma
-- (tb_institution_has_payment_types): PK compartilhada = 1 contrato por
-- forma (D2 — validade é INFORMATIVA, troca de taxa = editar). A PRESENÇA
-- do contrato é o único gatilho de baixa automática no faturamento (D1/D9):
-- sem contrato = título nasce aberto, sem tratamento (regra 4 do Valdo).
--   tb_bank_account_id  0 = caixa (exige caixa do usuário aberto — regra 1)
--                       > 0 = conta corrente (sem FK física: sentinela 0,
--                       mesma convenção de tb_financial_statement — a
--                       existência da conta é validada na aplicação)
--   fee_rate            taxa (%) descontada pela operadora — débito no
--                       mesmo settled_code da baixa (D3/D5)
--   payment_term        prazo em DIAS até o dinheiro ficar disponível —
--                       dt_record = data do faturamento + prazo × parcela
--                       (D12); dt_original = fato gerador (D6)
--   expiration_date     vencido = AVISA e gera o financeiro aberto (D11)
-- Espécie/PIX = contrato com taxa 0 e prazo 0 ("cai na hora" — D4/D22).
-- Cheque ('Q') é fixo por kind (onda própria) e boleto ('B') nunca baixa
-- no nascimento (decisão 14/QF1): contrato nessas formas não muda o fluxo
-- (D16/D18).
--
-- usage_preference do vínculo APOSENTADA (D17): o destino (caixa × banco)
-- passa a vir do contrato.

CREATE TABLE IF NOT EXISTS `tb_financial_contract` (
  `tb_institution_id`   int(11) NOT NULL,
  `tb_payment_types_id` int(11) NOT NULL,
  `tb_bank_account_id`  int(11) NOT NULL DEFAULT 0
    COMMENT '0 = caixa; > 0 = tb_bank_account.id (sentinela, sem FK física)',
  `fee_rate`            decimal(5,2) NOT NULL DEFAULT 0.00
    COMMENT 'Taxa % descontada pela operadora (0 = sem taxa)',
  `payment_term`        int(11) NOT NULL DEFAULT 0
    COMMENT 'Dias até o dinheiro ficar disponível (0 = cai na hora)',
  `expiration_date`     date DEFAULT NULL,
  `note`                text DEFAULT NULL,
  `created_at`          datetime DEFAULT NULL,
  `updated_at`          datetime DEFAULT NULL,
  `deleted`             char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_payment_types_id`),
  CONSTRAINT `fk_fc_payment_type_link`
    FOREIGN KEY (`tb_institution_id`, `tb_payment_types_id`)
    REFERENCES `tb_institution_has_payment_types` (`tb_institution_id`, `tb_payment_types_id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `tb_institution_has_payment_types`
  DROP COLUMN IF EXISTS `usage_preference`;
