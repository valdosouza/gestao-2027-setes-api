-- =============================================================
-- Migration: 019_product_kind.sql
-- Natureza do produto (decisao D2 — prompt_notas_mercadoria_servico.md,
-- 2026-07-26): tb_product.kind char(1) espelhando TB_PRODUTO.PRO_TIPO
-- ('P' produto acabado | 'M' materia-prima | 'S' servico).
-- Backfill: o PRO_TIPO ja viajava e esta gravado em tb_merchandise.kind;
-- produto SEM linha em tb_merchandise = servico nato da web (Software House).
-- Correcao de dados: servicos sincronizados como mercadoria (bug do
-- /merchandise pre-fase) perdem a especializacao indevida via soft delete
-- (nunca DELETE fisico — decisao D2 da revisao do sync).
-- =============================================================

ALTER TABLE `tb_product`
  ADD COLUMN `kind` char(1) NOT NULL DEFAULT 'P' AFTER `description`,
  ADD KEY `idx_product_kind` (`kind`);

UPDATE `tb_product` p
  INNER JOIN `tb_merchandise` m
    ON m.`id` = p.`id` AND m.`tb_institution_id` = p.`tb_institution_id`
  SET p.`kind` = m.`kind`
  WHERE m.`kind` IN ('P','M','S');

UPDATE `tb_product` p
  LEFT JOIN `tb_merchandise` m
    ON m.`id` = p.`id` AND m.`tb_institution_id` = p.`tb_institution_id`
  SET p.`kind` = 'S'
  WHERE m.`id` IS NULL;

UPDATE `tb_stock` s
  INNER JOIN `tb_merchandise` m
    ON m.`id` = s.`tb_merchandise_id` AND m.`tb_institution_id` = s.`tb_institution_id`
  SET s.`deleted` = 'S', s.`updated_at` = NOW()
  WHERE m.`kind` = 'S';

UPDATE `tb_merchandise` m
  SET m.`deleted` = 'S', m.`updated_at` = NOW()
  WHERE m.`kind` = 'S';
