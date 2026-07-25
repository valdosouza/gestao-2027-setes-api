-- =============================================================
-- Migration: 018_brand_package_measure_central.sql
-- Revisão do Sincronizador — Onda 3 (decisões D5/D17/D24 do prompt
-- Infra-IA/setes-sync/prompt_revisao_sincronizador_setes_sync.md):
-- Marca/Embalagem/Medida viram catálogo CENTRAL compartilhado
-- (setes_central.tb_brand/tb_package/tb_measure — sql/01), padrão
-- "catálogo iniciado pelo cliente" (molde tb_payment_types, migration 011).
--
-- No schema do cliente:
--   1. Derruba os catálogos LOCAIS do baseline (vazios em dev — D24: a
--      central inicia do ZERO, sem dedupe retroativo) e as has-tables
--      legadas (FKs para tb_institution/catálogo LOCAIS — mesmo problema
--      das migrations 009/010/014/015).
--   2. Recria tb_institution_has_{brand,package,measure} com FK
--      cross-schema (institution E catálogo na central). O vínculo tem
--      `active` (cliente desabilita sem excluir a linha compartilhada —
--      decisão do Valdo no rascunho: "inativar ou soft delete").
--   3. Realinha a FK tb_stock.tb_measure_id para a central.
-- DEPENDÊNCIA: setes_central.tb_brand/tb_package/tb_measure (sql/01).
-- =============================================================

-- 1. FK da tb_stock apontava para a tb_measure LOCAL — solta antes do drop
ALTER TABLE `tb_stock` DROP FOREIGN KEY `fk_stock_2`;

-- 2. Derruba has-tables legadas e catálogos locais (vazios — D24)
DROP TABLE IF EXISTS `tb_institution_has_brand`;
DROP TABLE IF EXISTS `tb_institution_has_package`;
DROP TABLE IF EXISTS `tb_institution_has_measure`;
DROP TABLE IF EXISTS `tb_brand`;
DROP TABLE IF EXISTS `tb_package`;
DROP TABLE IF EXISTS `tb_measure`;

-- 3. Vínculos novos: FK cross-schema, active no vínculo, KEY updated_at (sync)
CREATE TABLE `tb_institution_has_brand` (
  `tb_institution_id` INT NOT NULL,
  `tb_brand_id`       INT NOT NULL,
  `active`            CHAR(1) NOT NULL DEFAULT 'S',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_brand_id`),
  KEY `idx_ihb_brand` (`tb_brand_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_ihb_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_ihb_brand` FOREIGN KEY (`tb_brand_id`) REFERENCES `setes_central`.`tb_brand` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE `tb_institution_has_package` (
  `tb_institution_id` INT NOT NULL,
  `tb_package_id`     INT NOT NULL,
  `active`            CHAR(1) NOT NULL DEFAULT 'S',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_package_id`),
  KEY `idx_ihp_package` (`tb_package_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_ihp_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_ihp_package` FOREIGN KEY (`tb_package_id`) REFERENCES `setes_central`.`tb_package` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE `tb_institution_has_measure` (
  `tb_institution_id` INT NOT NULL,
  `tb_measure_id`     INT NOT NULL,
  `active`            CHAR(1) NOT NULL DEFAULT 'S',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_measure_id`),
  KEY `idx_ihm_measure` (`tb_measure_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_ihm_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_ihm_measure` FOREIGN KEY (`tb_measure_id`) REFERENCES `setes_central`.`tb_measure` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 4. tb_stock volta a ter FK de medida — agora para a central
ALTER TABLE `tb_stock`
  ADD CONSTRAINT `fk_tb_stock_measure` FOREIGN KEY (`tb_measure_id`) REFERENCES `setes_central`.`tb_measure` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
