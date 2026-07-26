-- =============================================================
-- Migration: 016_partnership_flat.sql
-- PARCERIA v2 (Valdo, 2026-07-19 — prompt_parceria_v2.md, decisões D1–D7):
-- o trio tb_partnership/_customer/_partner era MAQUETE de um pensamento
-- anterior (parceria como entidade nomeada). O conceito real é a
-- ANGARIAÇÃO: colaborador trouxe o cliente — a parceria É do cliente.
-- UMA tabela flat: 1 linha por colaborador envolvido naquele cliente.
--
--   D1: PK natural (institution, customer, collaborator)
--   D2: sem nome/descrição (histórico vive nos títulos — D11 do módulo)
--   D3: acesso vira ABA do cliente (standalone aposentado)
--   D7: active char(1) — suspende parceiro sem excluir a linha
--
-- CONVERSÃO: trio vivo → linhas flat (cliente × parceiro da mesma
-- parceria); INSERT IGNORE dedupe pela PK. Depois DROP das 3 legadas.
-- A regra "cliente em só 1 parceria viva" (Onda 3) morre POR CONSTRUÇÃO.
-- =============================================================

CREATE TABLE `tb_partnership_flat` (
  `tb_institution_id`  INT NOT NULL,
  `tb_customer_id`     INT NOT NULL,
  `tb_collaborator_id` INT NOT NULL,
  `rate`               DECIMAL(10,2) NOT NULL DEFAULT 0,
  `active`             CHAR(1) NOT NULL DEFAULT 'S',
  `created_at`         DATETIME DEFAULT NULL,
  `updated_at`         DATETIME DEFAULT NULL,
  `deleted`            CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_customer_id`, `tb_collaborator_id`),
  KEY `idx_partnership_collaborator` (`tb_institution_id`, `tb_collaborator_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_tb_partnership_customer` FOREIGN KEY (`tb_customer_id`, `tb_institution_id`) REFERENCES `tb_customer` (`id`, `tb_institution_id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_tb_partnership_collaborator` FOREIGN KEY (`tb_collaborator_id`, `tb_institution_id`) REFERENCES `tb_collaborator` (`id`, `tb_institution_id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

INSERT IGNORE INTO `tb_partnership_flat`
  (`tb_institution_id`, `tb_customer_id`, `tb_collaborator_id`, `rate`,
   `active`, `created_at`, `updated_at`, `deleted`)
SELECT pc.tb_institution_id, pc.tb_customer_id, pp.tb_collaborator_id,
       COALESCE(pp.rate, 0), 'S', NOW(), NOW(), 'N'
FROM `tb_partnership_customer` pc
INNER JOIN `tb_partnership` p
   ON p.id = pc.tb_partnership_id
  AND p.tb_institution_id = pc.tb_institution_id AND p.deleted = 'N'
INNER JOIN `tb_partnership_partner` pp
   ON pp.tb_partnership_id = p.id
  AND pp.tb_institution_id = p.tb_institution_id AND pp.deleted = 'N'
WHERE pc.deleted = 'N';

DROP TABLE IF EXISTS `tb_partnership_partner`;
DROP TABLE IF EXISTS `tb_partnership_customer`;
DROP TABLE IF EXISTS `tb_partnership`;

RENAME TABLE `tb_partnership_flat` TO `tb_partnership`;
