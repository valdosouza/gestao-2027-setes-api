-- =============================================================
-- Migration: 012_payment_types_link_attrs.sql
-- Atributos do VÍNCULO das formas de pagamento (Valdo, 2026-07-18):
-- tb_institution_has_payment_types ganha a configuração operacional da
-- forma por institution.
--
-- RENAMES (semântica, dados preservados):
--   active       -> enable      (o cliente não pode excluir a linha do
--                                catálogo compartilhado — desabilita por
--                                um tempo)
--   app_delivery -> app_mobile  (o app de delivery virou app mobile)
--
-- NOVAS COLUNAS:
--   block_for_customer_blocked   'S' = não mostrar p/ cliente bloqueado
--   block_for_customer_no_limit  'S' = bloquear p/ cliente sem limite de
--                                crédito
--   max_parcels                  nº máximo de parcelas permitidas
--   tef                          'S' = usa TEF (Transferência Eletrônica
--                                de Fundos)
--   tb_financial_plans_id_cre    Plano de Contas — Resultado (kind 'R')
--   tb_financial_plans_id_deb    Plano de Contas — Centro de Custo ('C')
--     (referência por coluna SEM FK física — padrão tb_financial_*;
--      DEFAULT 0 = não definido, mesmo espírito de tb_customer.
--      tb_payment_types_id)
--   usage_preference             lançamento em 'C'aixa / 'B'anco /
--                                'A'mbos (default)
-- =============================================================

ALTER TABLE `tb_institution_has_payment_types`
  CHANGE COLUMN `active`       `enable`     CHAR(1) NOT NULL DEFAULT 'S',
  CHANGE COLUMN `app_delivery` `app_mobile` CHAR(1) NOT NULL DEFAULT 'N',
  ADD COLUMN `block_for_customer_blocked`  CHAR(1) NOT NULL DEFAULT 'N' AFTER `app_mobile`,
  ADD COLUMN `block_for_customer_no_limit` CHAR(1) NOT NULL DEFAULT 'N' AFTER `block_for_customer_blocked`,
  ADD COLUMN `max_parcels`                 INT NOT NULL DEFAULT 1 AFTER `block_for_customer_no_limit`,
  ADD COLUMN `tef`                         CHAR(1) NOT NULL DEFAULT 'N' AFTER `max_parcels`,
  ADD COLUMN `tb_financial_plans_id_cre`   INT NOT NULL DEFAULT 0 AFTER `tef`,
  ADD COLUMN `tb_financial_plans_id_deb`   INT NOT NULL DEFAULT 0 AFTER `tb_financial_plans_id_cre`,
  ADD COLUMN `usage_preference`            CHAR(1) NOT NULL DEFAULT 'A' AFTER `tb_financial_plans_id_deb`;
