-- 049 — Índice do contador MAX+1 de tb_order_stock_adjust (A1 do re-score
-- socrático final da Rodada 4, 2026-09-09; família 048/045/044/041).
-- Desde a regra 7 (lock da institution) a abertura de devolução cunha
-- MAX(number) SOB o X da institution — sem índice com o prefixo do WHERE
-- (PK é id, institution, terminal) o MAX era type ALL: scan sob lock global.
ALTER TABLE `tb_order_stock_adjust`
  ADD KEY IF NOT EXISTS `idx_stock_adjust_number` (`tb_institution_id`, `number`);
