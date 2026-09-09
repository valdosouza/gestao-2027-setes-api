-- 045 — Numeração da nota pelo ÍNDICE (Q-G4 do cancelamento de nota, gate
-- socrático 1ª rodada; Valdo 2026-09-09 "Rec."; família do Q-G5/041 e 044).
--
-- `nextInvoiceNumber` faz MAX+1 por (institution, modelo, série, vivas) sobre
-- `number` VARCHAR com CAST — sem índice utilizável, o FOR UPDATE varria e
-- travava TODAS as notas da institution a cada faturamento/cancelamento.
-- Coluna GERADA `number_seq` (number numérico; não numérico → 0) + índice
-- com o prefixo exato do WHERE: o MAX vira leitura do fim do índice e o lock
-- fica no intervalo (modelo, série). MariaDB 10.4: IF NOT EXISTS idempotente.
ALTER TABLE `tb_invoice`
  ADD COLUMN IF NOT EXISTS `number_seq` INT UNSIGNED
    AS (IF(`number` REGEXP '^[0-9]{1,9}$', CAST(`number` AS UNSIGNED), 0)) STORED
    COMMENT 'number como inteiro (coluna gerada) — MAX+1 por modelo/série pelo índice (migration 045)';
ALTER TABLE `tb_invoice`
  ADD KEY IF NOT EXISTS `idx_invoice_number_seq` (`tb_institution_id`, `model`, `serie`, `deleted`, `number_seq`);
