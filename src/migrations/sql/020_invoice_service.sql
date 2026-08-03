-- =============================================================
-- Migration: 020_invoice_service.sql
-- Ramo de servico da nota fiscal (decisao D3 — prompt_notas_mercadoria_servico.md,
-- 2026-07-26): tb_invoice e objeto generico; a natureza e o RAMO —
-- tb_invoice_merchandise (mercadoria, ja existia no baseline) ×
-- tb_invoice_service (servico, criada aqui). Nota conjugada = os dois
-- ramos presentes no mesmo id (id = NFL_CODIGO, decisao D1).
-- Ramo minimo — cresce quando houver fato gerador (emissao nativa de NFS-e).
-- =============================================================

CREATE TABLE IF NOT EXISTS `tb_invoice_service` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `total_value` decimal(10,2) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`, `terminal`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_tb_invoice_service_invoice` FOREIGN KEY (`id`, `tb_institution_id`, `terminal`)
    REFERENCES `tb_invoice` (`id`, `tb_institution_id`, `terminal`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
