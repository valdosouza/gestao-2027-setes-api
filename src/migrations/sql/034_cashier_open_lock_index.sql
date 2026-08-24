-- 034 — Índice de apoio pra trava de abertura de caixa (achado do gate
-- socrático 2026-08-22, Q-Caixa 7).
--
-- `tb_cashier` só tinha a PK (id, tb_institution_id, terminal) — o
-- `SELECT ... FOR UPDATE` de `openCashier` (WHERE tb_institution_id=?
-- AND terminal=? AND tb_user_id=? AND hr_end IS NULL) não tinha nenhum
-- índice pra "prender" a trava quando a resposta é "nenhum caixa aberto"
-- (o caso mais comum — abrir o 1º caixa do dia): sem índice líder
-- cobrindo o predicado, um SELECT que devolve 0 linhas não garante
-- exclusão mútua real em InnoDB — dois cliques quase simultâneos do
-- mesmo usuário podiam abrir DOIS caixas no mesmo dia.
--
-- hr_end fica de fora da lista de colunas do índice (timestamp nullable,
-- baixa seletividade complementar) — as 3 primeiras colunas já cobrem o
-- predicado que precisa de trava; MySQL usa o índice pra localizar as
-- linhas do usuário e filtra hr_end IS NULL na leitura.

ALTER TABLE `tb_cashier`
  ADD KEY `idx_cashier_open_lock` (`tb_institution_id`, `terminal`, `tb_user_id`);
