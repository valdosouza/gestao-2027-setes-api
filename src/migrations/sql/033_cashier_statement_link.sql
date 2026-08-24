-- 033 — Caixa como feature WEB (fase Faturamento Fiscal e Financeiro, W3.2
-- — parecer setes-conceito 2026-08-22, Q-Caixa 1/5).
--
-- `tb_financial_statement.tb_bank_account_id = 0` JÁ é o sentinela de
-- "caixa" no motor de baixa existente (`settlements.repository.settleBatch`
-- — `stage = input.bankAccountId > 0 ? 'B' : 'C'`); não é maquete: é uma
-- marca de NATUREZA do movimento (precedente real do legado,
-- `TB_MOVIM_FINANCEIRO.MVF_CODCTB=0`), não uma linha fake em
-- `tb_bank_account`. O que faltava era saber DE QUAL SESSÃO de caixa
-- (`tb_cashier`) veio cada movimento — sem isso não dá pra consultar "o
-- movimento deste caixa" nem fechar com conferência.
--
-- `tb_cashier`/`tb_cashier_items` (baseline, dormentes pro lado web — só o
-- Sincronizador escreve) já são a fundação certa: `tb_cashier` = sessão
-- (abrir/fechar por dia+usuário+terminal); `tb_cashier_items` = a
-- CONFERÊNCIA do fechamento (registrado × digitado por forma de
-- pagamento — mesma tela do legado, nunca escrita pela web). Nenhuma das
-- duas precisa de DDL novo.

ALTER TABLE `tb_financial_statement`
  ADD COLUMN `tb_cashier_id` int(11) DEFAULT NULL
    COMMENT 'Sessão de caixa (tb_cashier) — preenchido só quando tb_bank_account_id = 0 (caixa)'
    AFTER `tb_bank_account_id`,
  ADD KEY `idx_statement_cashier` (`tb_institution_id`, `tb_cashier_id`);
