-- 041 — Índices dos CONTADORES MAX+1 por institution (Q-G5 do contrato
-- financeiro, decidida "vai" em 2026-09-07 — explicação revista em
-- prompt_contrato_financeiro_baixa_automatica.md §Q-G5, medida com EXPLAIN).
--
-- Os contadores `SELECT COALESCE(MAX(id),0)+1 … WHERE tb_institution_id = ?
-- FOR UPDATE` de tb_financial_statement (toda baixa/movimento) e de tb_check
-- (todo cheque recebido) têm PK que começa por `id`: o MAX exige LER todas as
-- linhas da institution e, sendo FOR UPDATE, TRAVA todas — com centenas de
-- milhares de lançamentos cada baixa serializa o financeiro inteiro do
-- cliente. Com (tb_institution_id, id) o MAX sai do fim do índice (custo
-- constante, lock só no último registro). settled_code já tinha índice
-- desde a 013 (idx_statement_settled / idx_payment_settled). Índices puros,
-- zero regra nova.

ALTER TABLE `tb_financial_statement`
  ADD KEY `idx_statement_inst_id` (`tb_institution_id`, `id`);

ALTER TABLE `tb_check`
  ADD KEY `idx_check_inst_id` (`tb_institution_id`, `id`);
