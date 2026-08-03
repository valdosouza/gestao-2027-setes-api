-- =============================================================
-- Migration: 021_drop_dead_tables.sql
-- Remocoes (decisoes D4/D5 — prompt_notas_mercadoria_servico.md, 2026-07-26):
-- - tb_order_item_detail_* e tb_order_item_flex: resquicio do modulo
--   restaurante aposentado (D23 da revisao do sync); zero uso em codigo.
--   A mae tb_order_item_detail cai junto (filhas primeiro, por FK).
-- - tb_provisional_receipt_service: RPS ocioso do baseline, sem canal de
--   sincronia (retorno NFS-e + /filexml cobrem RPS/lote/protocolo — D4);
--   quando a web emitir NFS-e nativa a peca nasce do fato gerador real.
-- =============================================================

DROP TABLE IF EXISTS `tb_order_item_detail_observation`;
DROP TABLE IF EXISTS `tb_order_item_detail_optional`;
DROP TABLE IF EXISTS `tb_order_item_detail_remove`;
DROP TABLE IF EXISTS `tb_order_item_detail`;
DROP TABLE IF EXISTS `tb_order_item_flex`;
DROP TABLE IF EXISTS `tb_provisional_receipt_service`;
