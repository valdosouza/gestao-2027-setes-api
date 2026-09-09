-- 048 — Índices dos contadores MAX+1 restantes (Q-G25 do re-score socrático
-- da Rodada 3 do cancelamento de nota, 2026-09-09; família do Q-G5/041, 044, 045).
--
-- Regra 5 + regra 7 do PADROES_BANCO §9: contador cunhado SOB o lock da
-- institution precisa de índice cujo prefixo é o WHERE — senão o MAX vira um
-- scan inteiro sob next-key lock enquanto a institution está travada.
-- `tb_order_sale.number` (abertura de venda: hoje `ref` em tb_institution_id
-- varrendo todas as vendas) e `tb_bank_slip.id` (emissão de boleto: varria
-- idx_bank_slip_expiration). MariaDB: IF NOT EXISTS idempotente.
ALTER TABLE `tb_order_sale`
  ADD KEY IF NOT EXISTS `idx_order_sale_number` (`tb_institution_id`, `number`);
ALTER TABLE `tb_bank_slip`
  ADD KEY IF NOT EXISTS `idx_bank_slip_counter` (`tb_institution_id`, `id`);
