-- =============================================================
-- Migration: 003_setes_app_fase1.sql
-- setes-app Fase 1 (Fundação) — prompt_fase1_fundacao.md
-- Alinha o schema do cliente ao modelo canônico (decisão 24 / Q15):
--   1. Remove as versões LEGADAS das tabelas de UI criadas pelo baseline
--      (catálogo tb_interface/tb_privilege vive SÓ em setes_central — Fase 2)
--   2. Cria as 4 tabelas de configuração do institution (decisão 18)
--      no formato canônico de sql/03_schema_cliente_ddl.sql
-- Sem migração de dados: não há clientes em produção (decisão 18 da Fase 2)
-- =============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- 1. Remoção do legado de UI (filhas primeiro)
DROP TABLE IF EXISTS `tb_user_has_privilege`;
DROP TABLE IF EXISTS `tb_interface_has_privilege`;
DROP TABLE IF EXISTS `tb_institution_has_module`;
DROP TABLE IF EXISTS `tb_module_has_interface`;
DROP TABLE IF EXISTS `tb_institution_has_interface`;
DROP TABLE IF EXISTS `tb_module`;
DROP TABLE IF EXISTS `tb_interface`;
DROP TABLE IF EXISTS `tb_privilege`;

-- 2. Contrato comercial: interfaces liberadas para o cliente (decisões 17, 18, 23)
CREATE TABLE IF NOT EXISTS `tb_institution_has_interface` (
  `tb_institution_id` INT NOT NULL,
  `tb_interface_id`   INT NOT NULL,
  `active`            CHAR(1) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_interface_id`),
  KEY `idx_ihi_interface` (`tb_interface_id`),
  CONSTRAINT `fk_ihi_to_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_ihi_to_interface` FOREIGN KEY (`tb_interface_id`) REFERENCES `setes_central`.`tb_interface` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 3. Módulos definidos pelo cliente (decisão 18; id pela aplicação — decisão 7 Fase 2)
CREATE TABLE IF NOT EXISTS `tb_module` (
  `id`          INT NOT NULL,
  `description` VARCHAR(100) DEFAULT NULL,
  `link_name`   VARCHAR(255) NOT NULL,
  `image_icon`  INT DEFAULT 0,
  `created_at`  DATETIME DEFAULT NULL,
  `updated_at`  DATETIME DEFAULT NULL,
  `deleted`     CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 4. Detail do módulo (Master-Detail — decisão 18)
CREATE TABLE IF NOT EXISTS `tb_module_has_interface` (
  `tb_module_id`    INT NOT NULL,
  `tb_interface_id` INT NOT NULL,
  `active`          CHAR(1) DEFAULT NULL,
  `created_at`      DATETIME DEFAULT NULL,
  `updated_at`      DATETIME DEFAULT NULL,
  `deleted`         CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_module_id`,`tb_interface_id`),
  KEY `idx_mhi_interface` (`tb_interface_id`),
  CONSTRAINT `fk_mhi_to_module` FOREIGN KEY (`tb_module_id`) REFERENCES `tb_module` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_mhi_to_interface` FOREIGN KEY (`tb_interface_id`) REFERENCES `setes_central`.`tb_interface` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 5. Privilégios do usuário por interface (decisões 18, 21)
CREATE TABLE IF NOT EXISTS `tb_user_has_privilege` (
  `tb_user_id`      INT NOT NULL,
  `tb_interface_id` INT NOT NULL,
  `tb_privilege_id` INT NOT NULL,
  `active`          CHAR(1) DEFAULT NULL,
  `created_at`      DATETIME DEFAULT NULL,
  `updated_at`      DATETIME DEFAULT NULL,
  `deleted`         CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_user_id`,`tb_interface_id`,`tb_privilege_id`),
  KEY `idx_uhp_interface` (`tb_interface_id`),
  KEY `idx_uhp_privilege` (`tb_privilege_id`),
  CONSTRAINT `fk_uhpriv_to_user` FOREIGN KEY (`tb_user_id`) REFERENCES `setes_central`.`tb_user` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_uhpriv_to_interface` FOREIGN KEY (`tb_interface_id`) REFERENCES `setes_central`.`tb_interface` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_uhpriv_to_privilege` FOREIGN KEY (`tb_privilege_id`) REFERENCES `setes_central`.`tb_privilege` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
