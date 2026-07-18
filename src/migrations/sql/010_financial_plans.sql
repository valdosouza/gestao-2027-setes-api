-- =============================================================
-- Migration: 010_financial_plans.sql
-- PLANO DE CONTAS (pedido do Valdo, 2026-07-18): 2º cadastro em ÁRVORE
-- (posit_level materializado — porta do reg_plano_contas.pas), POR
-- institution (PK composta; id MAX+1 por institution na aplicação).
--
-- Semântica das colunas (mapeada em ControllerPlanoContas.pas):
--   source_ = Natureza: 'C' Credora / 'D' Devedora        (nome legado mantido)
--   kind    = Tipo da Conta: 'C' Centro de Custo / 'R' Contas de Resultado
--   cluster = Nível de Visualização: 'S' Sintética / 'A' Analítica
--
-- REALINHAMENTO (mesmo padrão das 008/009): o 001_baseline.sql já cria a
-- tabela — esta migration derruba a versão legada e cria a canônica
-- (FK cross-schema p/ setes_central.tb_institution; description NOT NULL;
-- domínios em CHAR(1); active NOT NULL DEFAULT 'S'; KEY updated_at p/ o
-- sync incremental). Seguro: roda na criação do schema, tabela vazia nos
-- schemas vivos e nenhuma FK física aponta para ela (tb_products/
-- tb_financial_* referenciam por coluna sem constraint).
-- =============================================================

DROP TABLE IF EXISTS `tb_financial_plans`;

CREATE TABLE `tb_financial_plans` (
  `id`                INT NOT NULL,
  `tb_institution_id` INT NOT NULL,
  `posit_level`       VARCHAR(50) NOT NULL,
  `description`       VARCHAR(100) NOT NULL,
  `source_`           CHAR(1) NOT NULL DEFAULT 'C',
  `kind`              CHAR(1) NOT NULL DEFAULT 'C',
  `cluster`           CHAR(1) NOT NULL DEFAULT 'S',
  `active`            CHAR(1) NOT NULL DEFAULT 'S',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  KEY `idx_tb_financial_plans_institution` (`tb_institution_id`),
  KEY `source_` (`source_`),
  KEY `kind` (`kind`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_tb_financial_plans_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
