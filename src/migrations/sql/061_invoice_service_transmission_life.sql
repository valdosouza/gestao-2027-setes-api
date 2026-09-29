-- 061 — Rodada 2 dos gates da Onda 3 NFS-e (prompts/prompt_onda3_nfse_adn.md §10.4/§10.5):
--
-- D-N27 (MEDIUM-1 do socrático): a transmissão pertence a uma VIDA da nota — o evento E
-- (tb_invoice_event) que a emitiu. Cancelar e refaturar o MESMO id (revive, D3) abre vida
-- nova: sem esta coluna a tela "No fisco", o XML e o DANFSe mostravam a NFS-e CANCELADA
-- da vida anterior como se fosse da nota nova, e a lista de pendentes não a via.
-- Backfill = último E anterior (ou igual) à criação da tentativa; sem E localizável fica
-- NULL (linha continua visível para os leitores — nunca some história).
ALTER TABLE `tb_invoice_service_transmission`
  ADD COLUMN IF NOT EXISTS `invoice_event` INT DEFAULT NULL
    COMMENT 'Evento E da nota (vida) a que a tentativa pertence — D-N27' AFTER `environment`;

UPDATE `tb_invoice_service_transmission` t
   SET t.`invoice_event` = (
     SELECT MAX(ev.`event`) FROM `tb_invoice_event` ev
      WHERE ev.`tb_institution_id` = t.`tb_institution_id` AND ev.`tb_invoice_id` = t.`tb_invoice_id`
        AND ev.`terminal` = t.`terminal` AND ev.`kind` = 'E' AND ev.`deleted` = 'N'
        AND (ev.`created_at` IS NULL OR t.`created_at` IS NULL OR ev.`created_at` <= t.`created_at`))
 WHERE t.`invoice_event` IS NULL;
