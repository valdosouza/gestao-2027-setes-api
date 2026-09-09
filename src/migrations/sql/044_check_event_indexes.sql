-- 044 — Índices de tb_check_event (Q-G8 do cancelamento de nota, gate
-- socrático 2ª rodada, 2026-09-09; família do Q-G5/migration 041).
--
-- O plano do cancelamento e a guarda de Baixas (Q-G7) leem tb_check_event por
-- (tb_institution_id, tb_order_id) SOB FOR UPDATE; sem índice o otimizador
-- varria todos os cheques da institution e travava TODO movimento de cheque
-- até o commit (EXPLAIN no dev). O segundo índice serve o grupo de recebimento
-- (irmãos do mesmo settled_code em reverseCheckEvent). MariaDB: IF NOT EXISTS.
ALTER TABLE `tb_check_event`
  ADD KEY IF NOT EXISTS `idx_check_event_order` (`tb_institution_id`, `tb_order_id`),
  ADD KEY IF NOT EXISTS `idx_check_event_code` (`tb_institution_id`, `settled_code`);
