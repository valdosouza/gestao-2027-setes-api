-- =============================================================
-- Migration: 008_collaborator.sql
-- Onda 2 da Entidade Única — papel COLABORADOR (hierarquia de papéis,
-- decisão 16 do Framework de Configurações): tb_collaborator no schema do
-- cliente, herança por PK (id = setes_central.tb_entity.id), papel por
-- institution (PK composta).
--
-- ⚠️ REALINHAMENTO (fix 2026-07-18): o 001_baseline.sql (dump do legado) já
-- cria uma tb_collaborator com o typo `fahters_name`, sem FKs e com tamanhos
-- antigos — um CREATE IF NOT EXISTS aqui seria no-op e o INSERT do módulo
-- quebraria (Unknown column 'fathers_name'). Esta migration DERRUBA a versão
-- legada e cria a canônica (padrão fix-forward da migration 005). Seguro:
-- roda na criação do schema (antes de qualquer sync) e nenhuma tabela do
-- baseline tem FK para tb_collaborator; schemas legados COM dados serão
-- tratados na revisão do sync (mapeamento fahters_name → fathers_name).
--
-- Precedência Collaborator→Salesman: na APLICAÇÃO quando o cadastro de
-- salesman nascer.
-- =============================================================

DROP TABLE IF EXISTS `tb_collaborator`;

CREATE TABLE `tb_collaborator` (
  `id`                   INT NOT NULL,
  `tb_institution_id`    INT NOT NULL,
  `active`               CHAR(1) NOT NULL DEFAULT 'S',
  `dt_admission`         DATE DEFAULT NULL,
  `dt_resignation`       DATE DEFAULT NULL,
  `salary`               DECIMAL(10,2) DEFAULT NULL,
  `fathers_name`         VARCHAR(100) DEFAULT NULL,
  `mothers_name`         VARCHAR(100) DEFAULT NULL,
  `vote_number`          VARCHAR(20) DEFAULT NULL,
  `vote_zone`            VARCHAR(10) DEFAULT NULL,
  `vote_section`         VARCHAR(10) DEFAULT NULL,
  `military_certificate` VARCHAR(30) DEFAULT NULL,
  `pis`                  VARCHAR(20) DEFAULT NULL,
  `created_at`           DATETIME DEFAULT NULL,
  `updated_at`           DATETIME DEFAULT NULL,
  `deleted`              CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  KEY `idx_tb_collaborator_institution` (`tb_institution_id`),
  CONSTRAINT `fk_tb_collaborator_entity` FOREIGN KEY (`id`) REFERENCES `setes_central`.`tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_tb_collaborator_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
