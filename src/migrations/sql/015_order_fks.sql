-- =============================================================
-- Migration: 015_order_fks.sql
-- Realinhamento das FKs legadas do backbone tb_order (2026-07-19):
-- o baseline aponta tb_user_id e tb_institution_id para as tabelas LOCAIS
-- (vazias — aguardam a revisão do sync), o que IMPEDE abrir qualquer
-- ordem. Mesmo fix-forward das migrations 009/010/014: FKs cross-schema
-- explícitas para setes_central. Necessária para as Ordens de Serviço do
-- Módulo Software House (013).
-- =============================================================

ALTER TABLE `tb_order`
  DROP FOREIGN KEY `tb_order_ibfk_1`,
  DROP FOREIGN KEY `tb_order_ibfk_2`,
  ADD CONSTRAINT `fk_tb_order_user` FOREIGN KEY (`tb_user_id`) REFERENCES `setes_central`.`tb_user` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_tb_order_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD KEY `updated_at` (`updated_at`);
