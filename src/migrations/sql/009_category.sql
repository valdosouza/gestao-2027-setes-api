-- =============================================================
-- Migration: 009_category.sql
-- Cadastro de CATEGORIAS de produtos e serviços (pedido do Valdo,
-- 2026-07-18): tb_category no schema do cliente, papel por institution
-- (PK composta id + tb_institution_id; id gerado MAX+1 por institution).
--
-- REALINHAMENTO (mesmo padrão da 008): o 001_baseline.sql (dump do legado)
-- já cria tb_category — esta migration derruba a versão legada e cria a
-- canônica: FK cross-schema para setes_central.tb_institution (a do
-- baseline apontava para a tb_institution LOCAL legada) e active
-- char(1) NOT NULL DEFAULT 'S' (era varchar(1) NULL). Seguro: roda na
-- criação do schema (antes de qualquer sync), nenhuma tabela tem FK para
-- tb_category (tb_products.tb_category_id é coluna sem constraint) e a
-- tabela está vazia nos schemas vivos. KEY updated_at preservada (sync
-- incremental). kind: 'P' = produto, 'S' = serviço.
-- =============================================================

DROP TABLE IF EXISTS `tb_category`;

CREATE TABLE `tb_category` (
  `id`                INT NOT NULL,
  `tb_institution_id` INT NOT NULL,
  `description`       VARCHAR(100) NOT NULL,
  `posit_level`       VARCHAR(40) DEFAULT NULL,
  `kind`              CHAR(1) DEFAULT NULL,
  `active`            CHAR(1) NOT NULL DEFAULT 'S',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  KEY `idx_tb_category_institution` (`tb_institution_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_tb_category_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
