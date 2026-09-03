-- 037 — Onda 3 da Regra de Tributação de Serviço (prompt_regra_tributacao_servico.md,
-- D6/D8/D12/D14, 2026-09-03): vínculo por ITEM da regra de serviço (paridade
-- com tb_order_item_tax_rule) + tax_code do ISSQN alargado para o código
-- municipal. O drop de tb_city.aliq_iss (D8) é da CENTRAL: sql/45.

-- Regra de tributação de SERVIÇO POR ITEM da ordem — irmã da
-- tb_order_item_tax_rule (D14 do prompt_regra_tributacao_servico.md:
-- paridade com mercadoria, INCLUINDO RegraDireta). origin 'A' = gravada
-- pelo /billing/validate (re-resolvida a cada validação); 'M' = escolha
-- manual do cliente (nunca sobrescrita). FK da regra não é física (mesma
-- escolha da 031: regra soft-deletada é detectada no faturamento).
CREATE TABLE IF NOT EXISTS `tb_order_item_service_tax_rule` (
  `tb_order_id`             int(11) NOT NULL,
  `tb_order_item_id`        int(11) NOT NULL,
  `tb_institution_id`       int(11) NOT NULL,
  `terminal`                int(11) NOT NULL DEFAULT 0,
  `kind`                    varchar(50) NOT NULL DEFAULT 'Service',
  `tb_service_tax_rule_id`  int(11) NOT NULL,
  `origin`                  char(1) NOT NULL,
  `created_at`              datetime DEFAULT NULL,
  `updated_at`              datetime DEFAULT NULL,
  `deleted`                 char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`,`tb_order_item_id`,`tb_institution_id`,`terminal`,`kind`),
  KEY `idx_oistr_rule` (`tb_institution_id`,`tb_service_tax_rule_id`),
  CONSTRAINT `fk_oistr_order` FOREIGN KEY (`tb_order_id`,`tb_institution_id`,`terminal`)
    REFERENCES `tb_order` (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- tb_order_item_issqn.tax_code recebe o CÓDIGO DE TRIBUTAÇÃO MUNICIPAL da
-- regra (D4) — o legado reservava 1 char; municípios usam até 20.
ALTER TABLE `tb_order_item_issqn` MODIFY `tax_code` varchar(20) DEFAULT NULL;
