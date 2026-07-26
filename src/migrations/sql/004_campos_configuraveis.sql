-- =============================================================
-- Migration: 004_campos_configuraveis.sql
-- setes-app Fase 2 (Campos configuráveis) — prompt_fase2_campos_configuraveis.md
-- Cria tb_institution_has_field no schema do cliente (decisões 2, 5 e 12):
-- especialização por institution (caption/required/mask) sobre o baseline
-- técnico do catálogo setes_central.tb_interface_has_field.
-- DEPENDÊNCIA: setes_central.tb_interface_has_field precisa existir antes
-- (sql/01 — aplicada por `npm run db:bootstrap`).
-- =============================================================

CREATE TABLE IF NOT EXISTS `tb_institution_has_field` (
  `tb_institution_id` INT NOT NULL,
  `tb_interface_id`   INT NOT NULL,
  `field_name`        VARCHAR(100) NOT NULL,
  `field_caption`     VARCHAR(100) DEFAULT NULL,
  `required`          CHAR(1) DEFAULT NULL,
  `mask`              VARCHAR(50) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_interface_id`,`field_name`),
  KEY `idx_inhf_field` (`tb_interface_id`,`field_name`),
  CONSTRAINT `fk_inhf_to_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_inhf_to_field` FOREIGN KEY (`tb_interface_id`,`field_name`) REFERENCES `setes_central`.`tb_interface_has_field` (`tb_interface_id`,`field_name`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
