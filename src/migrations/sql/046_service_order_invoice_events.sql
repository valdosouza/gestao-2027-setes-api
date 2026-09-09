-- 046 — Nota da ORDEM DE SERVIÇO ganha história (Q-G3 do cancelamento de
-- nota; Valdo 2026-09-09: "deve ser cancelável").
--
-- O módulo service-orders gravava tb_invoice inline com status 'A'
-- (placeholder — nenhuma nota da web é autorizada; a transmissão é fase
-- guardada) e SEM evento E → a peça @shared/invoice a tratava como
-- "sincronizada — cancele na origem". A partir desta migration a OS fatura
-- pela peça (E + D4 por modelo/série 'SE'/'1'); aqui as notas de OS já
-- existentes entram no mesmo modelo: status '0' (pendente) + E retroativo.
-- Idempotente (NOT EXISTS). IDENTIDADE da OS (C-1 do gate socrático, Q-G11 a):
-- tb_order_service SEM tb_order_sale — a venda com item de serviço também tem
-- tb_order_service (presença) e a nota dela já entrou pela 042. O pedido de
-- serviço PURO sincronizado também NÃO tem tb_order_sale (N-1 do re-score):
-- quem o deixa de fora aqui é o filtro `model = 'SE'` — a NFS-e sincronizada
-- viaja SEM model (CONTRATOS_SYNC.md) — e, no cancelamento, a exigência do
-- evento E na web (Q-P1). Ver a conferência abaixo antes de aplicar.
-- CONFERÊNCIA antes de aplicar em schema de produção (Q-G14):
--   SELECT i.id, i.model, i.status FROM tb_invoice i JOIN tb_order_service s ON s.id=i.id
--    AND s.tb_institution_id=i.tb_institution_id AND s.terminal=i.terminal
--   WHERE i.deleted='N' AND NOT EXISTS (SELECT 1 FROM tb_invoice_event e WHERE e.tb_invoice_id=i.id
--    AND e.tb_institution_id=i.tb_institution_id AND e.terminal=i.terminal)
--    AND NOT EXISTS (SELECT 1 FROM tb_order_sale os WHERE os.id=s.id AND os.tb_institution_id=s.tb_institution_id
--    AND os.terminal=s.terminal AND os.deleted='N');
--   → só notas 'SE' status 'A' do módulo service-orders devem aparecer.
UPDATE `tb_invoice` i
  JOIN `tb_order_service` s
    ON s.id = i.id AND s.tb_institution_id = i.tb_institution_id AND s.terminal = i.terminal
   SET i.status = '0', i.updated_at = NOW()
 WHERE i.model = 'SE' AND i.deleted = 'N' AND i.status = 'A'
   AND NOT EXISTS (SELECT 1 FROM `tb_order_sale` os
                    WHERE os.id = s.id AND os.tb_institution_id = s.tb_institution_id
                      AND os.terminal = s.terminal AND os.deleted = 'N')
   AND NOT EXISTS (SELECT 1 FROM `tb_invoice_event` e
                    WHERE e.tb_institution_id = i.tb_institution_id
                      AND e.tb_invoice_id = i.id AND e.terminal = i.terminal);
INSERT INTO `tb_invoice_event`
  (`tb_institution_id`, `tb_invoice_id`, `terminal`, `event`, `kind`, `dt_record`,
   `number`, `serie`, `model`, `value`, `origin_event`, `note`, `tb_user_id`,
   `created_at`, `updated_at`, `deleted`)
SELECT i.`tb_institution_id`, i.`id`, i.`terminal`, 1, 'E', i.`dt_emission`,
       i.`number`, i.`serie`, i.`model`, i.`value`, NULL, 'retroativo (OS)', NULL,
       NOW(), NOW(), 'N'
  FROM `tb_invoice` i
  JOIN `tb_order_service` s
    ON s.id = i.id AND s.tb_institution_id = i.tb_institution_id AND s.terminal = i.terminal
 WHERE i.`model` = 'SE' AND i.`deleted` = 'N'
   AND NOT EXISTS (SELECT 1 FROM `tb_order_sale` os
                    WHERE os.id = s.id AND os.tb_institution_id = s.tb_institution_id
                      AND os.terminal = s.terminal AND os.deleted = 'N')
   AND NOT EXISTS (SELECT 1 FROM `tb_invoice_event` e
                    WHERE e.`tb_institution_id` = i.`tb_institution_id`
                      AND e.`tb_invoice_id` = i.`id` AND e.`terminal` = i.`terminal`);
