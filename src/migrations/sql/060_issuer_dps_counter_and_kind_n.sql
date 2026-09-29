-- 060 — Retrabalho do gate socrático da Onda 3 NFS-e (prompts/prompt_onda3_nfse_adn.md):
--
-- D-N18 (HIGH-2): o contador do nDPS vive no EMISSOR. `MAX(dps_number)` do ramo
-- esquecia números já usados no fisco — a nota cancelada é soft-deletada (D3) e o
-- revive zera `dps_number` (nova vida = novo nDPS, Id novo), então a próxima
-- cunhagem repetia um nDPS que o fisco já conhecia. Backfill = MAX do ramo
-- INCLUINDO deleted='S', por institution. Trocar a `serie` do emissor NÃO zera o
-- contador (numeração contínua; o Id do DPS inclui a série — sem colisão).
ALTER TABLE `tb_establishment_issuer`
  ADD COLUMN IF NOT EXISTS `dps_last_number` INT NOT NULL DEFAULT 0
    COMMENT 'Último nDPS cunhado pelo emissor SE (D-N18) — contínuo mesmo trocando a série' AFTER `serie`;

UPDATE `tb_establishment_issuer` i
   SET i.`dps_last_number` = (
     SELECT COALESCE(MAX(s.`dps_number`), 0) FROM `tb_invoice_service` s
      WHERE s.`tb_institution_id` = i.`tb_institution_id`)
 WHERE i.`model` = 'SE' AND i.`dps_last_number` = 0;

-- D-N17 (HIGH-1): kind N = "pedido de cancelamento NÃO consta no fisco" — voz da
-- consulta depois de um K sem resposta; devolve a transmissão a AUTORIZADA e
-- libera novo pedido de cancelamento. Só o COMENTÁRIO muda (CHAR(1) sem CHECK,
-- estado derivado pela peça — mesma regra das outras famílias de evento).
ALTER TABLE `tb_invoice_service_transmission_event`
  MODIFY `kind` CHAR(1) NOT NULL
    COMMENT 'S enviado · A autorizada · R rejeitada · C cancelada · K cancelamento em voo · F falha explícita · N pedido de cancelamento não consta no fisco (segue autorizada — D-N17)';
