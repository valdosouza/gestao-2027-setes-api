-- 059 — dps_id deixa de ser UNIQUE por institution (Onda 3 NFS-e, composição
-- @shared/invoice-transmission — prompts/prompt_onda3_nfse_adn.md §9 etapa 3).
--
-- D-N3: o nDPS é do RAMO (write-once, cunhado na 1ª transmissão) e TODA
-- tentativa reusa o mesmo nDPS — logo o mesmo Id do DPS (cMun + tpInsc +
-- inscrição + série + nDPS). Reapresentar = attempt + 1 (nunca UPDATE), então
-- a 2ª tentativa depois de uma rejeição (R) ou falha (F) grava o MESMO dps_id
-- noutra linha — a UNIQUE (tb_institution_id, dps_id) da 058 estourava com
-- ER_DUP_ENTRY exatamente no caminho que a D-N3 desenha. A busca por dps_id
-- (reconciliação do envio em voo) continua indexada; a chave de acesso
-- (access_key) segue UNIQUE: essa é do fisco e nunca se repete.
ALTER TABLE `tb_invoice_service_transmission`
  DROP INDEX IF EXISTS `uk_invoice_service_transmission_dps`;
ALTER TABLE `tb_invoice_service_transmission`
  ADD KEY IF NOT EXISTS `idx_invoice_service_transmission_dps` (`tb_institution_id`, `dps_id`);
