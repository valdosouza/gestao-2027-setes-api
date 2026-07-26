-- =============================================================
-- Migration: 006_entity_tax.sql
-- Fase 3 (Entidade Única) — Rodada 4: Tributação por entidade
-- (decisões 14–19 do prompt_fase3_entidade_unica.md, Valdo 2026-07-16)
--
-- 1. tb_entity_tax: tributação POR RELAÇÃO COMERCIAL (entity × institution) —
--    QUALQUER entidade pode precisar de tributação para receber notas, não só
--    clientes. Fonte única: os campos fiscais SAEM de setes_central.tb_company
--    (decisão 16 — bootstrap dropa as colunas de lá; dados da base existente
--    copiados por script one-off ANTES do drop).
-- 2. tb_customer emagrece: consumer/by_pass_st migram para tb_entity_tax;
--    wallet char(1) vira tb_payment_types_id INT (decisão 18 — "Sim" na UI
--    grava o id da forma de pagamento "Carteira", criada on-demand);
--    multiplier NOT NULL DEFAULT 1; active DEFAULT 'S'.
--
-- UI (instruções por campo — preparação para a aba Tributação):
--   consumer            radiobox [S]im / [N]ão
--   tax_regime          dropdown canônico (decisão 15):
--                         1 - Simples Nacional
--                         2 - Simples Nacional - excesso de sublimite de receita bruta
--                         3 - Regime Normal - Lucro Real
--                         3 - Regime Normal - Lucro Presumido (mesmo código 3)
--                       (grava o RÓTULO completo; o código NFe é o 1º caractere)
--   by_pass_st          checkbox S/N
--   ind_ie_dest         dropdown/radiogroup:
--                         [1] Contribuinte ICMS (informar a IE do destinatário)
--                         [2] Contribuinte isento de Inscrição no cadastro de Contribuintes do ICMS
--                         [9] Não Contribuinte (pode ou não possuir IE)
--   iss_exigibilidade   dropdown com os 7 códigos do legado (CHAR(2), decisão 15):
--                         01 Exigível · 02 Não incidência · 03 Isenção ·
--                         04 Exportação · 05 Imunidade · 06 Susp. judicial ·
--                         07 Susp. administrativa
--   iss_process_nr      texto (25)
--   iss_retido          radiobox S/N
--   iss_ind_inc_fiscal  radiobox S/N
--   auto_send_invoice   checkbox S/N
--   auto_send_invoice_just_xml  checkbox S/N
-- No tb_customer:
--   credit_status       radiobox [L]iberado / [B]loqueado
--   wallet (UI)         radiobox Sim/Não → API resolve tb_payment_types_id
--                       ("Carteira" autocreate — porta do Fc_PegaFormaPgto)
-- =============================================================

CREATE TABLE IF NOT EXISTS `tb_entity_tax` (
  `id`                         INT NOT NULL,
  `tb_institution_id`          INT NOT NULL,
  `consumer`                   CHAR(1) DEFAULT 'N',
  `tax_regime`                 VARCHAR(100) DEFAULT NULL,
  `by_pass_st`                 CHAR(1) DEFAULT 'N',
  `ind_ie_dest`                CHAR(1) DEFAULT NULL,
  `iss_exigibilidade`          CHAR(2) DEFAULT NULL,
  `iss_process_nr`             VARCHAR(25) DEFAULT NULL,
  `iss_retido`                 CHAR(1) DEFAULT 'N',
  `iss_ind_inc_fiscal`         CHAR(1) DEFAULT 'N',
  `auto_send_invoice`          CHAR(1) DEFAULT 'N',
  `auto_send_invoice_just_xml` CHAR(1) DEFAULT 'N',
  `created_at`                 DATETIME DEFAULT NULL,
  `updated_at`                 DATETIME DEFAULT NULL,
  `deleted`                    CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  KEY `idx_tb_entity_tax_institution` (`tb_institution_id`),
  CONSTRAINT `fk_tb_entity_tax_entity`
    FOREIGN KEY (`id`)
    REFERENCES `setes_central`.`tb_entity` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_tb_entity_tax_institution`
    FOREIGN KEY (`tb_institution_id`)
    REFERENCES `setes_central`.`tb_institution` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Migra consumer/by_pass_st dos clientes existentes (fonte: o próprio
-- tb_customer, que ainda tem as colunas neste ponto da migration)
INSERT INTO `tb_entity_tax` (`id`, `tb_institution_id`, `consumer`, `by_pass_st`, `created_at`, `updated_at`)
SELECT c.`id`, c.`tb_institution_id`, COALESCE(c.`consumer`, 'N'), COALESCE(c.`by_pass_st`, 'N'), NOW(), NOW()
FROM `tb_customer` c
ON DUPLICATE KEY UPDATE `updated_at` = NOW();

-- Forma de pagamento "Carteira" (fiado/pendurado) para clientes legados com
-- wallet='S' — id_nfce '05' = Crédito Loja (decisão 18)
INSERT INTO `tb_payment_types` (`id`, `description`, `id_nfce`, `created_at`, `updated_at`)
SELECT (SELECT COALESCE(MAX(p.`id`), 0) + 1 FROM `tb_payment_types` p), 'Carteira', '05', NOW(), NOW()
FROM DUAL
WHERE EXISTS (SELECT 1 FROM `tb_customer` WHERE `wallet` = 'S' AND `deleted` = 'N')
  AND NOT EXISTS (SELECT 1 FROM `tb_payment_types` WHERE `description` = 'Carteira' AND `deleted` = 'N');

ALTER TABLE `tb_customer` ADD COLUMN `tb_payment_types_id` INT NOT NULL DEFAULT 0 AFTER `wallet`;

UPDATE `tb_customer`
SET `tb_payment_types_id` = COALESCE(
  (SELECT `id` FROM `tb_payment_types` WHERE `description` = 'Carteira' AND `deleted` = 'N' LIMIT 1), 0)
WHERE `wallet` = 'S';

UPDATE `tb_customer` SET `multiplier` = 1 WHERE `multiplier` IS NULL;

ALTER TABLE `tb_customer`
  DROP COLUMN `consumer`,
  DROP COLUMN `by_pass_st`,
  DROP COLUMN `wallet`,
  MODIFY `multiplier` DECIMAL(10,2) NOT NULL DEFAULT 1,
  MODIFY `active` CHAR(1) DEFAULT 'S';
