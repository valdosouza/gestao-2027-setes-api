-- =============================================================
-- Migration: 013_ordem_servico.sql
-- Módulo Software House / Ordem de Serviço (Valdo, 2026-07-18) — DDL da
-- Fase 5 do prompt FECHADO Infra-IA/setes-api/prompt_modulo_software_house.md
-- (decisões D1–D15 + DP1–DP12 validadas; entregáveis no doc 05-ORDEM-SERVICO).
--
-- BLOCOS (ordem importa):
--   1. Financeiro (P6/P7/P8 + 5.5): id vestigial fora, event na PK do
--      payment, status N/E/R + vínculos de estorno, índices.
--   2. Parcerias: trio do baseline ganha PKs (DP4) e tb_customer_id.
--   3. Bancos (DP2): catálogo local sobe p/ setes_central.tb_bank por
--      number (dedupe), contas/históricos remapeados, local derrubada.
--   4. Item universal (DP6): estoque/preço saem p/ tb_order_item_merchandise.
--   5. Tabelas novas: tb_contract, tb_contract_item, tb_order_service (D5
--      via open_lock mantida pela APLICAÇÃO — DP7), tb_order_financial (DP10).
--
-- DEPENDÊNCIA: setes_central.tb_bank precisa existir antes (sql/01 novo ou
-- sql/16 em base existente) — mesmo padrão da migration 011.
-- SINCRONIZADOR: segue o padrão depois (decisão do Valdo) — os endpoints
-- /sync/financial* e de itens serão realinhados na revisão do sync.
-- =============================================================

-- ---------- 1. FINANCEIRO ----------

ALTER TABLE `tb_financial`
  DROP COLUMN `id`,
  ADD KEY `idx_fin_expiration` (`tb_institution_id`, `dt_expiration`),
  ADD KEY `updated_at` (`updated_at`);

ALTER TABLE `tb_financial_bills`
  DROP COLUMN `id`,
  MODIFY COLUMN `kind`      CHAR(2) DEFAULT NULL,
  MODIFY COLUMN `situation` CHAR(1) NOT NULL DEFAULT 'N',
  MODIFY COLUMN `operation` CHAR(1) DEFAULT NULL,
  MODIFY COLUMN `stage`     CHAR(1) NOT NULL DEFAULT 'N',
  ADD KEY `idx_bills_kind_stage` (`tb_institution_id`, `kind`, `stage`),
  ADD KEY `updated_at` (`updated_at`);

ALTER TABLE `tb_financial_payment`
  DROP COLUMN `id`,
  ADD COLUMN `event` INT NOT NULL DEFAULT 1 AFTER `parcel`,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (`tb_institution_id`, `tb_order_id`, `terminal`, `parcel`, `event`),
  ADD COLUMN `status`          CHAR(1) NOT NULL DEFAULT 'N',
  ADD COLUMN `origin_event`    INT DEFAULT NULL,
  ADD COLUMN `reversal_reason` VARCHAR(100) DEFAULT NULL,
  ADD KEY `idx_payment_settled` (`tb_institution_id`, `settled_code`),
  ADD KEY `updated_at` (`updated_at`);

ALTER TABLE `tb_financial_statement`
  ADD COLUMN `status` CHAR(1) NOT NULL DEFAULT 'N',
  ADD COLUMN `tb_financial_statement_id_origin` INT DEFAULT NULL,
  ADD KEY `idx_statement_settled` (`tb_institution_id`, `settled_code`),
  ADD KEY `idx_statement_account` (`tb_institution_id`, `tb_bank_account_id`, `dt_record`),
  ADD KEY `updated_at` (`updated_at`);

-- ---------- 2. PARCERIAS (baseline SEM PK — checklist revisar-ddl) ----------

ALTER TABLE `tb_partnership`
  ADD PRIMARY KEY (`id`, `tb_institution_id`),
  ADD KEY `updated_at` (`updated_at`);

ALTER TABLE `tb_partnership_customer`
  CHANGE COLUMN `tb_customer` `tb_customer_id` INT NOT NULL,
  ADD PRIMARY KEY (`tb_institution_id`, `tb_partnership_id`, `tb_customer_id`),
  ADD KEY `idx_partnership_by_customer` (`tb_institution_id`, `tb_customer_id`),
  ADD KEY `updated_at` (`updated_at`);

ALTER TABLE `tb_partnership_partner`
  ADD PRIMARY KEY (`tb_institution_id`, `tb_partnership_id`, `tb_collaborator_id`),
  ADD KEY `updated_at` (`updated_at`);

-- ---------- 3. BANCOS: catálogo sobe para a central (DP2) ----------

INSERT INTO `setes_central`.`tb_bank` (`id`, `number`, `description`, `created_at`, `updated_at`, `deleted`)
SELECT (SELECT COALESCE(MAX(c2.id), 0) FROM `setes_central`.`tb_bank` c2)
         + ROW_NUMBER() OVER (ORDER BY l.id),
       l.number, NULL, NOW(), NOW(), 'N'
FROM `tb_bank` l
WHERE l.deleted = 'N'
  AND NOT EXISTS (SELECT 1 FROM `setes_central`.`tb_bank` c
                  WHERE c.number = l.number COLLATE utf8mb4_unicode_ci);

UPDATE `tb_bank_account` a
  JOIN `tb_bank` l ON l.id = a.tb_bank_id
  JOIN `setes_central`.`tb_bank` c ON c.number = l.number COLLATE utf8mb4_unicode_ci
   SET a.tb_bank_id = c.id, a.updated_at = NOW();

UPDATE `tb_bank_historic` h
  JOIN `tb_bank` l ON l.id = h.tb_bank_id
  JOIN `setes_central`.`tb_bank` c ON c.number = l.number COLLATE utf8mb4_unicode_ci
   SET h.tb_bank_id = c.id, h.updated_at = NOW();

DROP TABLE IF EXISTS `tb_bank`;

ALTER TABLE `tb_bank_account`
  ADD KEY `idx_bank_account_bank` (`tb_bank_id`),
  ADD CONSTRAINT `fk_tb_bank_account_bank` FOREIGN KEY (`tb_bank_id`) REFERENCES `setes_central`.`tb_bank` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------- 4. ITEM UNIVERSAL (DP6) ----------

CREATE TABLE IF NOT EXISTS `tb_order_item_merchandise` (
  `id`                INT NOT NULL,
  `tb_institution_id` INT NOT NULL,
  `tb_order_id`       INT NOT NULL,
  `terminal`          INT NOT NULL DEFAULT 0,
  `tb_stock_list_id`  INT NOT NULL,
  `tb_price_list_id`  INT DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`, `tb_order_id`, `terminal`),
  KEY `tb_stock_list_id` (`tb_stock_list_id`),
  KEY `updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

INSERT IGNORE INTO `tb_order_item_merchandise`
  (`id`, `tb_institution_id`, `tb_order_id`, `terminal`, `tb_stock_list_id`,
   `tb_price_list_id`, `created_at`, `updated_at`, `deleted`)
SELECT i.id, i.tb_institution_id, i.tb_order_id, i.terminal,
       i.tb_stock_list_id, i.tb_price_list_id, i.created_at, NOW(), i.deleted
FROM `tb_order_item` i
WHERE i.tb_stock_list_id > 0;

ALTER TABLE `tb_order_item`
  DROP COLUMN `tb_stock_list_id`,
  DROP COLUMN `tb_price_list_id`;

-- ---------- 5. TABELAS NOVAS ----------

CREATE TABLE IF NOT EXISTS `tb_contract` (
  `id`                INT NOT NULL,
  `tb_institution_id` INT NOT NULL,
  `tb_customer_id`    INT NOT NULL,
  `dt_start`          DATE NOT NULL,
  `dt_end`            DATE DEFAULT NULL,
  `payment_day`       INT NOT NULL DEFAULT 5,
  `active`            CHAR(1) NOT NULL DEFAULT 'S',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  KEY `idx_tb_contract_customer` (`tb_institution_id`, `tb_customer_id`, `active`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_tb_contract_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_tb_contract_customer` FOREIGN KEY (`tb_customer_id`) REFERENCES `setes_central`.`tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tb_contract_item` (
  `tb_contract_id`    INT NOT NULL,
  `tb_institution_id` INT NOT NULL,
  `tb_product_id`     INT NOT NULL,
  `value`             DECIMAL(10,2) NOT NULL DEFAULT 0,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_contract_id`, `tb_institution_id`, `tb_product_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_tb_contract_item_contract` FOREIGN KEY (`tb_contract_id`, `tb_institution_id`) REFERENCES `tb_contract` (`id`, `tb_institution_id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tb_order_service` (
  `id`                INT NOT NULL,
  `tb_institution_id` INT NOT NULL,
  `terminal`          INT NOT NULL DEFAULT 0,
  `number`            INT DEFAULT NULL,
  `tb_customer_id`    INT NOT NULL,
  `open_lock`         VARCHAR(30) DEFAULT NULL,
  `created_at`        DATETIME NOT NULL,
  `updated_at`        DATETIME NOT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`, `terminal`),
  UNIQUE KEY `uk_open_per_customer` (`open_lock`),
  KEY `idx_service_customer` (`tb_institution_id`, `tb_customer_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_tb_order_service_order` FOREIGN KEY (`id`, `tb_institution_id`, `terminal`) REFERENCES `tb_order` (`id`, `tb_institution_id`, `terminal`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_tb_order_service_customer` FOREIGN KEY (`tb_customer_id`) REFERENCES `setes_central`.`tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tb_order_financial` (
  `id`                 INT NOT NULL,
  `tb_institution_id`  INT NOT NULL,
  `terminal`           INT NOT NULL DEFAULT 0,
  `tb_entity_id`       INT NOT NULL,
  `tb_order_id_origin` INT NOT NULL DEFAULT 0,
  `origin_parcel`      INT NOT NULL DEFAULT 0,
  `origin_event`       INT NOT NULL DEFAULT 0,
  `created_at`         DATETIME NOT NULL,
  `updated_at`         DATETIME NOT NULL,
  `deleted`            CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`, `terminal`),
  KEY `idx_order_financial_entity` (`tb_institution_id`, `tb_entity_id`),
  KEY `idx_order_financial_origin` (`tb_institution_id`, `tb_order_id_origin`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_tb_order_financial_order` FOREIGN KEY (`id`, `tb_institution_id`, `terminal`) REFERENCES `tb_order` (`id`, `tb_institution_id`, `terminal`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_tb_order_financial_entity` FOREIGN KEY (`tb_entity_id`) REFERENCES `setes_central`.`tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
