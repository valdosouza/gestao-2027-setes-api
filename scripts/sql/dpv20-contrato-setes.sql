-- =====================================================================
-- D-PV20 (Valdo, 2026-10-20 — Infra-IA/prompts/prompt_privilegios_interfaces.md): o contrato de telas da
-- SETES (institution 1, schema `setes_setes`) recebe, ANTES do merge da onda `privilegios-crud`, TUDO o
-- que as flags técnicas (`setes_central.tb_feature_flag` da institution 1) liberam hoje — incluindo as
-- estruturais `users`, `modules`, `interface-configs` e `general-configs` — para que o contrato passe a
-- dizer exatamente o que o atalho da institution 1 (D-PV10, morto) dizia e os dois admins não percam tela
-- nem engrenagem no dia do merge. O que a Setes não deva ter, o Super tira depois pela tela "Interfaces
-- dos clientes" (D-PV11).
--
-- GERADO em 2026-10-21 por LEITURA SÓ-LEITURA do banco do dev (NUNCA aplicado por esta sessão — item 1 do
-- roteiro do §11.8, só com o "vai"). Regra da lista: flag VIVA e ligada da institution 1 × interface
-- VENDÁVEL do catálogo (kind T/R fora do grupo Super), mais as 4 estruturais nomeadas pela decisão.
--   Flags vivas da Setes (28): bank-accounts, bank-charge-agreements, bank-slips, billing, carriers,
--   cashier, categories, checks, collaborators, contracts, customers, establishment, financial-plans,
--   modules, order-returns, orders, payment-types, price-lists, providers, salesmen, service-orders,
--   service-tax-rules, services, settlement-rules, settlements, state-tax-rates, tax-rules, users.
--   Fora da lista: `state-tax-rates` (sem interface no catálogo — D-PV23) e `partnerships` (flag
--   deleted='S' → pela D-PV22 a 'R' só entra se a flag estiver ligada; NÃO entra). `interface-fields`
--   ENTRA desde a D-PV54 (Valdo 2026-10-27 — virou ESTRUTURAL, gêmea da `interface-configs`; revê a nota da D-PV20 de 21/10).
--   Já contratadas (14, conferidas no banco): bank-charge-agreements, bank-slips, cashier, checks,
--   establishment, order-returns, orders, price-lists, service-orders, service-tax-rules, services,
--   settlement-rules, settlements, tax-rules.
--   NOVAS (16): bank-accounts, billing, carriers, categories, collaborators, contracts, customers,
--   financial-plans, general-configs, interface-configs, interface-fields, modules, payment-types, providers, salesmen, users.
--   Total depois: 30 interfaces no contrato da Setes.
--
-- Idempotente (INSERT … ON DUPLICATE KEY UPDATE revive/religa a linha; re-executar não muda nada).
-- Por `i18n_key`, nunca por id fixo. Conferência no fim FALHA ALTO se alguma interface esperada ficar
-- fora do contrato ("Table '...DPV20_FALHOU_interface_fora_do_contrato' doesn't exist").
-- Depois dele: seed 65 (tela delegável) → seed 68 (CONFIGURAR/CONSULTAR) → setes-api → app (§11.8).
-- =====================================================================

USE `setes_setes`;

DROP TEMPORARY TABLE IF EXISTS `tmp_dpv20_expected`;
CREATE TEMPORARY TABLE `tmp_dpv20_expected` (
  `k` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY
) ENGINE=MEMORY;

INSERT INTO `tmp_dpv20_expected` (`k`) VALUES
-- já contratadas (14) — ficam
('bank-charge-agreements'), ('bank-slips'), ('cashier'), ('checks'), ('establishment'), ('order-returns'), ('orders'),
('price-lists'), ('service-orders'), ('service-tax-rules'), ('services'), ('settlement-rules'), ('settlements'), ('tax-rules'),
-- novas pelas flags (11)
('bank-accounts'), ('billing'), ('carriers'), ('categories'), ('collaborators'), ('contracts'), ('customers'),
('financial-plans'), ('payment-types'), ('providers'), ('salesmen'),
-- estruturais (D-PV20 + D-PV54 — a lista de `STRUCTURAL_INTERFACE_KEYS`, menos `establishment`, que já está acima)
('users'), ('modules'), ('interface-configs'), ('general-configs'), ('interface-fields');

-- Conferência 0 (FALHA ALTO antes de gravar): toda chave esperada existe VIVA no catálogo central
SET @dpv20_unknown := (
  SELECT COUNT(*) FROM `tmp_dpv20_expected` e
   WHERE NOT EXISTS (SELECT 1 FROM `setes_central`.`tb_interface` i WHERE i.`i18n_key` = e.`k` AND i.`deleted` = 'N')
);
SET @dpv20_pre := IF(@dpv20_unknown = 0, 'DO 0', 'SELECT 1 FROM `DPV20_FALHOU_chave_fora_do_catalogo`');
PREPARE dpv20_pre FROM @dpv20_pre;
EXECUTE dpv20_pre;
DEALLOCATE PREPARE dpv20_pre;

INSERT INTO `tb_institution_has_interface`
  (`tb_institution_id`, `tb_interface_id`, `active`, `created_at`, `updated_at`)
SELECT 1, i.`id`, 'S', NOW(), NOW()
  FROM `tmp_dpv20_expected` e
  JOIN `setes_central`.`tb_interface` i ON i.`i18n_key` = e.`k` AND i.`deleted` = 'N'
ON DUPLICATE KEY UPDATE `active` = 'S', `deleted` = 'N', `updated_at` = NOW();

-- Conferência 1 (informativa): o contrato da Setes depois — esperado 30 linhas vivas
SELECT i.`i18n_key` AS `interface`, ihi.`active`, ihi.`deleted`
  FROM `tb_institution_has_interface` ihi
  JOIN `setes_central`.`tb_interface` i ON i.`id` = ihi.`tb_interface_id`
 WHERE ihi.`tb_institution_id` = 1 AND ihi.`active` = 'S' AND ihi.`deleted` = 'N'
 ORDER BY i.`i18n_key`;

-- Conferência 2 (FALHA ALTO): toda interface esperada está no contrato, viva
SET @dpv20_missing := (
  SELECT COUNT(*) FROM `tmp_dpv20_expected` e
   WHERE NOT EXISTS (
     SELECT 1 FROM `tb_institution_has_interface` ihi
       JOIN `setes_central`.`tb_interface` i ON i.`id` = ihi.`tb_interface_id` AND i.`deleted` = 'N'
      WHERE ihi.`tb_institution_id` = 1 AND i.`i18n_key` = e.`k` AND ihi.`active` = 'S' AND ihi.`deleted` = 'N')
);
SET @dpv20_check := IF(@dpv20_missing = 0, 'DO 0', 'SELECT 1 FROM `DPV20_FALHOU_interface_fora_do_contrato`');
PREPARE dpv20_check FROM @dpv20_check;
EXECUTE dpv20_check;
DEALLOCATE PREPARE dpv20_check;

DROP TEMPORARY TABLE IF EXISTS `tmp_dpv20_expected`;
