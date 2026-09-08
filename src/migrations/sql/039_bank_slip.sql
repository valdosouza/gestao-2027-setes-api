-- 039 — Boleto emitido (Infra-IA/prompts/prompt_boleto_emitido.md, D1–D11 —
-- Valdo, 2026-09-03; parecer setes-conceito). Onda 2 do financeiro (ordem
-- contrato → boleto → cheque, D11 do boleto).
--
-- Conceito: boleto = INSTRUMENTO de cobrança bancária que representa 1..N
-- títulos perante um banco. Três peças (nunca colapsadas no BLT_CODQTC do
-- legado, que misturava vínculo + nosso número + código da baixa):
--   tb_bank_slip        cabeçalho IMUTÁVEL após a emissão (taxas/instruções
--                       CONGELADAS da config — o banco cobra pelo registrado)
--   tb_bank_slip_title  vínculo boleto ↔ título (1 linha = 1:1; N = agrupado);
--                       SEM FK física ao título (decisão 33 — PK composta que o
--                       sync também escreve); reemissão = boleto novo com
--                       vínculos novos (história completa)
--   tb_bank_slip_event  história append-only: E emitido · L liquidado ·
--                       C cancelado · X estornado (S remessa / G registrado /
--                       A alterado reservados ao canal CNAB/API — fora desta
--                       onda, D6/D7). Estado = derivado do último evento.
--
-- Família tb_bank_charge_* relida contra o legado (D1): a antiga
-- tb_bank_charge_slip é a CONTRATAÇÃO de cobrança (TB_BOLETO_ELETRONICO =
-- convênio/carteira configurada) → RENOMEADA tb_bank_charge_agreement para
-- liberar "slip" ao boleto; tb_bank_charge_ticket = carteira bancária
-- (number + emission_by); tb_bank_charge_kind = espécie do documento.
-- Zero consumidores TS antes desta migration (verificado 2026-09-03).
--   active           D8: "registros ATIVOS" do gate 0/1/n do faturamento
--   our_number_next  D3: nosso número = sequência POR CARTEIRA (faixa é
--                    atributo da CONFIG); NULL = sem faixa → nosso número e
--                    nº do documento = id do boleto (fallback b)

RENAME TABLE `tb_bank_charge_slip` TO `tb_bank_charge_agreement`;

ALTER TABLE `tb_bank_charge_agreement`
  ADD COLUMN `active` char(1) NOT NULL DEFAULT 'S'
    COMMENT 'S = carteira em uso (conta no gate 0/1/n do faturamento — D8/D18)'
    AFTER `benefic_post`,
  ADD COLUMN `our_number_next` int(11) DEFAULT NULL
    COMMENT 'Próximo nosso número da carteira (D3); NULL = sem faixa, usa o id do boleto'
    AFTER `active`;

CREATE TABLE IF NOT EXISTS `tb_bank_slip` (
  `id`                          int(11) NOT NULL,
  `tb_institution_id`           int(11) NOT NULL,
  `tb_bank_charge_agreement_id` int(11) NOT NULL COMMENT 'Config de origem (rastreio)',
  `tb_bank_account_id`          int(11) NOT NULL COMMENT 'Conta CONGELADA na emissão',
  `tb_bank_charge_kind_id`      int(11) DEFAULT NULL COMMENT 'Espécie do documento congelada',
  `our_number`                  varchar(30) NOT NULL,
  `document_number`             varchar(30) NOT NULL,
  `dt_emission`                 date NOT NULL,
  `dt_expiration`               date NOT NULL,
  `value`                       decimal(10,2) NOT NULL,
  `accept`                      char(1) DEFAULT NULL,
  `aliq_discount`               decimal(10,2) DEFAULT NULL,
  `discount_value`              decimal(10,2) DEFAULT NULL,
  `dt_discount_until`           date DEFAULT NULL,
  `aliq_interest`               decimal(10,2) DEFAULT NULL,
  `aliq_late`                   decimal(10,2) DEFAULT NULL,
  `value_late_min`              decimal(10,2) DEFAULT NULL,
  `aliq_fine`                   decimal(10,2) DEFAULT NULL,
  `value_fine`                  decimal(10,2) DEFAULT NULL,
  `value_rate`                  decimal(10,2) DEFAULT NULL,
  `instruction`                 text DEFAULT NULL,
  `protest_days`                int(11) DEFAULT NULL,
  `protest_day_kind`            char(1) DEFAULT NULL COMMENT 'C corridos / U úteis',
  `negativation_days`           int(11) DEFAULT NULL,
  `tb_user_id`                  int(11) DEFAULT NULL,
  `created_at`                  datetime DEFAULT NULL,
  `updated_at`                  datetime DEFAULT NULL,
  `deleted`                     char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  KEY `idx_bank_slip_our_number` (`tb_institution_id`, `our_number`),
  KEY `idx_bank_slip_expiration` (`tb_institution_id`, `dt_expiration`),
  CONSTRAINT `fk_bank_slip_agreement`
    FOREIGN KEY (`tb_bank_charge_agreement_id`, `tb_institution_id`)
    REFERENCES `tb_bank_charge_agreement` (`id`, `tb_institution_id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_bank_slip_title` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_bank_slip_id`   int(11) NOT NULL,
  `tb_order_id`       int(11) NOT NULL,
  `terminal`          int(11) NOT NULL DEFAULT 0,
  `parcel`            int(11) NOT NULL,
  `value`             decimal(10,2) NOT NULL COMMENT 'Parcela do título dentro do boleto (rateio)',
  `created_at`        datetime DEFAULT NULL,
  `updated_at`        datetime DEFAULT NULL,
  `deleted`           char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_bank_slip_id`, `tb_order_id`, `terminal`, `parcel`),
  KEY `idx_bank_slip_title_title` (`tb_institution_id`, `tb_order_id`, `terminal`, `parcel`),
  CONSTRAINT `fk_bank_slip_title_slip`
    FOREIGN KEY (`tb_bank_slip_id`, `tb_institution_id`)
    REFERENCES `tb_bank_slip` (`id`, `tb_institution_id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_bank_slip_event` (
  `tb_institution_id`  int(11) NOT NULL,
  `tb_bank_slip_id`    int(11) NOT NULL,
  `event`              int(11) NOT NULL,
  `kind`               char(1) NOT NULL COMMENT 'E emitido, L liquidado, C cancelado, X estornado (S/G/A reservados ao canal)',
  `dt_record`          date NOT NULL,
  `source`             char(1) NOT NULL DEFAULT 'M' COMMENT 'M manual / R retorno CNAB / A API',
  `settled_code`       int(11) DEFAULT NULL COMMENT 'Código da baixa (evento L) ou do estorno (X)',
  `tb_bank_account_id` int(11) DEFAULT NULL,
  `paid_value`         decimal(10,2) DEFAULT NULL,
  `dt_expiration`      date DEFAULT NULL COMMENT 'Novo vencimento (evento A — canal)',
  `bank_code`          varchar(10) DEFAULT NULL,
  `bank_message`       varchar(100) DEFAULT NULL,
  `origin_event`       int(11) DEFAULT NULL COMMENT 'Evento desfeito (X → L)',
  `note`               varchar(255) DEFAULT NULL,
  `tb_user_id`         int(11) DEFAULT NULL,
  `created_at`         datetime DEFAULT NULL,
  `updated_at`         datetime DEFAULT NULL,
  `deleted`            char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_bank_slip_id`, `event`),
  CONSTRAINT `fk_bank_slip_event_slip`
    FOREIGN KEY (`tb_bank_slip_id`, `tb_institution_id`)
    REFERENCES `tb_bank_slip` (`id`, `tb_institution_id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
