-- 056 — Última CONSULTA ao banco por apresentação (gate socrático da Onda 2 Banco
-- Inter, 2026-09-19, HIGH-2; Q-I2 executada como assunção — ver
-- prompts/prompt_onda2_banco_inter.md §10).
--
-- O modelo da 055 separa bem "o banco DISSE X" (voz, append-only) — mas a consulta
-- que NÃO muda nada não deixava rastro nenhum. O "throttle" da consulta ativa
-- filtrava pelo created_at do último EVENTO: um boleto A_RECEBER há 20 dias era
-- sempre elegível, os 8 mais antigos eram reconsultados a CADA abertura de tela e
-- o 9º em diante nunca era consultado pela porta ativa (starvation) — no sandbox
-- de 10 chamadas/min, dois operadores abrindo a lista já davam 429.
--
-- `last_queried_at` é o fato "NÓS olhamos o banco" (write-many, como updated_at),
-- distinto da voz dele. Exceção deliberada à imutabilidade da apresentação, da
-- mesma família dos write-once da D-I6. NULL = nunca consultada → primeira no
-- rodízio. Índice com prefixo no WHERE da consulta ativa (regra 5 do PADROES §9).
ALTER TABLE `tb_bank_slip_registration`
  ADD COLUMN IF NOT EXISTS `last_queried_at` DATETIME DEFAULT NULL
    COMMENT 'Última consulta ao banco desta apresentação (throttle/rodízio da consulta ativa); NULL = nunca'
    AFTER `pix_txid`;
ALTER TABLE `tb_bank_slip_registration`
  ADD KEY IF NOT EXISTS `idx_bank_slip_registration_query` (`tb_institution_id`, `last_queried_at`);
