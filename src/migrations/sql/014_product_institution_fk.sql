-- =============================================================
-- Migration: 014_product_institution_fk.sql
-- Realinhamento da FK de institution do tb_product (2026-07-18):
-- o baseline aponta para a tb_institution LOCAL (vazia — aguarda a revisão
-- do sync), o que IMPEDE criar produtos. Mesmo fix-forward das migrations
-- 009 (tb_category) e 010 (tb_financial_plans): FK cross-schema explícita
-- para setes_central.tb_institution + KEY updated_at p/ sync incremental.
-- Necessária para os itens de contrato do Módulo Software House (013).
-- =============================================================

ALTER TABLE `tb_product`
  DROP FOREIGN KEY `tb_product_ibfk_2`,
  ADD CONSTRAINT `fk_tb_product_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD KEY `updated_at` (`updated_at`);
