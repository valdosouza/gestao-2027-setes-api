-- 043 — Reforma de tb_state_mva_ncm / tb_state_fcp_ncm para a forma da 030.
--
-- Achado colateral do gate adversarial do cancelamento de nota (2026-09-09):
-- o baseline (001) já criava as duas tabelas na forma do LEGADO (PK
-- tb_state_id+ncm, coluna `aliquota`/`mva`, sem `id` nem `tb_institution_id`)
-- e a 030 era `CREATE TABLE IF NOT EXISTS` → no-op. O repository do módulo
-- state-tax-rates lê `id`/`aliq`/`internal_aliq`, então TODO faturamento de
-- MERCADORIA caía em 500 (`Unknown column 'f.id'` em resolveFcpAliq) — o dev
-- nunca emitiu nota de mercadoria (0 linhas em tb_order_item_icms).
--
-- Reforma PRESERVANDO linhas (MariaDB 10.4: sem CHANGE COLUMN IF EXISTS →
-- condicional por prepared statement; o runner executa uma instrução por
-- linha terminada em ';' na MESMA conexão): se a tabela está na forma antiga
-- (sem `id`), renomeia para *_legacy, recria na forma da 030 e copia as
-- linhas com a institution DONA do schema; se já está na forma nova, nada
-- muda. Idempotente.

SET @inst := (SELECT id FROM setes_central.tb_institution WHERE schema_name = DATABASE() LIMIT 1);

-- ---------------------------------------------------------------- MVA por NCM
SET @legacy_mva := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tb_state_mva_ncm' AND COLUMN_NAME = 'id');
SET @sql := IF(@legacy_mva, 'RENAME TABLE `tb_state_mva_ncm` TO `tb_state_mva_ncm_legacy`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `tb_state_mva_ncm` (
  `id`                 int(11) NOT NULL,
  `tb_institution_id`  int(11) NOT NULL,
  `tb_state_id`        int(11) NOT NULL,
  `ncm`                varchar(8) NOT NULL,
  `internal_aliq`      decimal(10,2) NOT NULL DEFAULT 0,
  `mva_original`       decimal(10,4) NOT NULL DEFAULT 0,
  `mva_adjusted`       decimal(10,4) DEFAULT NULL,
  `created_at`         datetime DEFAULT NULL,
  `updated_at`         datetime DEFAULT NULL,
  `deleted`            char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_state_mva_ncm` (`tb_institution_id`,`tb_state_id`,`ncm`),
  CONSTRAINT `fk_state_mva_ncm_state` FOREIGN KEY (`tb_state_id`) REFERENCES `setes_central`.`tb_state` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @n := 0;
SET @sql := IF(@legacy_mva, 'INSERT INTO `tb_state_mva_ncm` (id, tb_institution_id, tb_state_id, ncm, internal_aliq, mva_original, mva_adjusted, created_at, updated_at, deleted) SELECT (@n := @n + 1), @inst, tb_state_id, ncm, COALESCE(aliquota, 0), COALESCE(mva, 0), NULL, created_at, updated_at, deleted FROM `tb_state_mva_ncm_legacy` ORDER BY tb_state_id, ncm', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
SET @sql := IF(@legacy_mva, 'DROP TABLE `tb_state_mva_ncm_legacy`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------- FCP por NCM
SET @legacy_fcp := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tb_state_fcp_ncm' AND COLUMN_NAME = 'id');
SET @sql := IF(@legacy_fcp, 'RENAME TABLE `tb_state_fcp_ncm` TO `tb_state_fcp_ncm_legacy`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `tb_state_fcp_ncm` (
  `id`                 int(11) NOT NULL,
  `tb_institution_id`  int(11) NOT NULL,
  `tb_state_id`        int(11) NOT NULL,
  `ncm`                varchar(8) NOT NULL,
  `aliq`               decimal(10,2) NOT NULL DEFAULT 0,
  `created_at`         datetime DEFAULT NULL,
  `updated_at`         datetime DEFAULT NULL,
  `deleted`            char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_state_fcp_ncm` (`tb_institution_id`,`tb_state_id`,`ncm`),
  CONSTRAINT `fk_state_fcp_ncm_state` FOREIGN KEY (`tb_state_id`) REFERENCES `setes_central`.`tb_state` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @n := 0;
SET @sql := IF(@legacy_fcp, 'INSERT INTO `tb_state_fcp_ncm` (id, tb_institution_id, tb_state_id, ncm, aliq, created_at, updated_at, deleted) SELECT (@n := @n + 1), @inst, tb_state_id, ncm, COALESCE(aliquota, 0), created_at, updated_at, deleted FROM `tb_state_fcp_ncm_legacy` ORDER BY tb_state_id, ncm', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
SET @sql := IF(@legacy_fcp, 'DROP TABLE `tb_state_fcp_ncm_legacy`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
