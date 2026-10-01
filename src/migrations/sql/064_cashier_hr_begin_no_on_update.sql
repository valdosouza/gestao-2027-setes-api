-- 064 — bug achado no censo da Q-TZ1 (2026-09-30, prompt_pesquisa_avancada.md §10):
-- `tb_cashier.hr_begin` veio do baseline com `ON UPDATE current_timestamp()` — o
-- `UPDATE ... SET hr_end = NOW()` do FECHAMENTO sobrescrevia a hora de ABERTURA com a
-- do fechamento (e qualquer UPDATE na linha a moveria). A abertura é fato gravado uma
-- vez (INSERT com NOW()); a coluna deixa de se mexer sozinha. TIMESTAMP continua
-- (instante — o servidor converte pelo fuso da sessão, hoje '+00:00').
ALTER TABLE `tb_cashier`
  MODIFY COLUMN `hr_begin` TIMESTAMP NULL DEFAULT NULL;
