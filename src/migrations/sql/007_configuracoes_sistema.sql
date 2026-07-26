-- =============================================================
-- Migration: 007_configuracoes_sistema.sql
-- Framework de Configurações do Sistema — prompt_framework_configuracoes_sistema.md
-- Cria tb_institution_has_config no schema do cliente (decisões 2 e 4):
-- valores escolhidos pelo cliente sobre o catálogo central
-- setes_central.tb_interface_has_config. Só grava o que DIVERGE do
-- default; resolução usuário → institution → default.
-- tb_user_id = 0 (sentinel) = valor da institution; >0 = override do
-- usuário (permitido apenas quando o catálogo marca scope='U').
-- DEPENDÊNCIA: setes_central.tb_interface_has_config precisa existir antes
-- (sql/01 — aplicada por `npm run db:bootstrap`).
-- =============================================================

CREATE TABLE IF NOT EXISTS `tb_institution_has_config` (
  `tb_institution_id` INT NOT NULL,
  `tb_interface_id`   INT NOT NULL,
  `name`              VARCHAR(50) NOT NULL,
  `tb_user_id`        INT NOT NULL DEFAULT 0,
  `content`           VARCHAR(100) NOT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_interface_id`,`name`,`tb_user_id`),
  KEY `idx_inhc_config` (`tb_interface_id`,`name`),
  CONSTRAINT `fk_inhc_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_inhc_config` FOREIGN KEY (`tb_interface_id`,`name`) REFERENCES `setes_central`.`tb_interface_has_config` (`tb_interface_id`,`name`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
