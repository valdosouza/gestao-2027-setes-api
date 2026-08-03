-- =============================================================
-- Migration: 022_provider_realign.sql
-- Onda 3 da Entidade Única (prompt_onda3_provider.md, D2/D3 —
-- 2026-08-03): tb_provider ficou FORA do realinhamento da Fase 3
-- (migration 005 cobriu customer/salesman/carrier; nenhuma tela
-- consumia o papel). Alinha ao padrão dos irmãos:
--   - FK id → setes_central.tb_entity (herança por PK — seguro:
--     pós-revisão do sync todo id gravado já é entity.id)
--   - FK tb_institution_id → setes_central.tb_institution
--   - active default 'S' (D3 — igual tb_carrier)
-- Baseline não tinha FK nesta tabela (só KEY) — nada a dropar.
-- =============================================================

ALTER TABLE `tb_provider`
  MODIFY `active` CHAR(1) NOT NULL DEFAULT 'S',
  ADD CONSTRAINT `fk_tb_provider_entity` FOREIGN KEY (`id`) REFERENCES `setes_central`.`tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_tb_provider_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
