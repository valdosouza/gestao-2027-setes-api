-- 040 — Cheque como portador de dívida (Infra-IA/prompts/prompt_cheque_
-- rastreabilidade.md, D1–D10 + D7a–c — Valdo, 2026-09-03). Onda 3 do
-- financeiro (ordem contrato → boleto → cheque).
--
-- Conceito: cheque = título ao PORTADOR que substitui a dívida do cliente a
-- partir da baixa do faturamento; o cheque NÃO nasce "por cadastrar" — nasce
-- na transação da baixa (evento R). Duas peças (papel imutável × história
-- append-only), igual ao boleto:
--   tb_check        cabeçalho IMUTÁVEL (banco/agência/conta/número/emitente/
--                   valor/data — "bom para"/kind P próprio ou T terceiro)
--   tb_check_event  história append-only: R recebido · B depositado ·
--                   D descontado · P usado em pagamento · T retornado com
--                   reembolso · F retornado bom · V devolvido · X estornado.
--                   Elo com o título por VALOR (orderId/parcel), SEM FK —
--                   decisão 33, mesmo padrão do boleto.
-- Estado derivado do ÚLTIMO evento: custódia = {R,F} · banco = B ·
-- factoring = D · fornecedor = P · em cobrança = V sem título quitado.
--
-- D5: UNIQUE (institution, banco, agência, conta, número) — cheque que volta
-- é o MESMO registro (o findOrCreate da peça reusa o id, nunca duplica).

CREATE TABLE IF NOT EXISTS `tb_check` (
  `id`                 INT NOT NULL,
  `tb_institution_id`  INT NOT NULL,
  `tb_bank_id`         INT NOT NULL COMMENT 'FK setes_central.tb_bank',
  `agency`             VARCHAR(10) NOT NULL,
  `account`            VARCHAR(15) NOT NULL,
  `number`             VARCHAR(20) NOT NULL,
  `issuer`             VARCHAR(100) NOT NULL,
  `value`              DECIMAL(10,2) NOT NULL,
  `dt_check`           DATE NOT NULL COMMENT '"Bom para" — pré-datado quando > dt do evento R',
  `kind`               CHAR(1) NOT NULL DEFAULT 'P' COMMENT 'P próprio (do pagador) / T terceiro',
  `created_at`         DATETIME DEFAULT NULL,
  `updated_at`         DATETIME DEFAULT NULL,
  `deleted`            CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  UNIQUE KEY `uq_check_identity` (`tb_institution_id`, `tb_bank_id`, `agency`, `account`, `number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_check_event` (
  `tb_institution_id`  INT NOT NULL,
  `tb_check_id`        INT NOT NULL,
  `event`              INT NOT NULL,
  `kind`               CHAR(1) NOT NULL COMMENT 'R B D P T F V X',
  `dt_record`          DATE NOT NULL,
  `tb_entity_id`        INT DEFAULT NULL COMMENT 'R: quem ENTREGOU; D/T: a factoring; P: o fornecedor pago',
  `settled_code`       INT DEFAULT NULL COMMENT 'Código da baixa/movimento (NULL no F — sem dinheiro)',
  `payment_event`      INT DEFAULT NULL COMMENT 'R/P: nº do evento em tb_financial_payment (p/ estorno)',
  `tb_order_id`        INT DEFAULT NULL COMMENT 'Elo por VALOR — sem FK (decisão 33)',
  `terminal`           INT DEFAULT NULL,
  `parcel`             INT DEFAULT NULL,
  `tb_bank_account_id` INT DEFAULT NULL COMMENT 'B/D: destino (0 = caixa)',
  `origin_event`       INT DEFAULT NULL COMMENT 'X: evento desfeito',
  `note`               VARCHAR(255) DEFAULT NULL,
  `tb_user_id`         INT DEFAULT NULL,
  `created_at`         DATETIME DEFAULT NULL,
  `updated_at`         DATETIME DEFAULT NULL,
  `deleted`            CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_check_id`, `event`),
  CONSTRAINT `fk_check_event_check`
    FOREIGN KEY (`tb_check_id`, `tb_institution_id`)
    REFERENCES `tb_check` (`id`, `tb_institution_id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
