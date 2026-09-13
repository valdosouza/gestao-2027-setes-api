-- 051 — Fato da rotina mensal: contrato × produto × COMPETÊNCIA → item da OS
-- (D-A29 = Q-A29 do cancelamento de nota, Valdo 2026-09-13). A idempotência da
-- rotina (05-ORDEM-SERVICO §3.4) usava DATE(created_at) do item dentro do mês da
-- competência — mas o item nasce na data da CORRIDA: reexecução RETROATIVA
-- (08/2026 rodada 3×) injetava em dobro. Guardião: o fato gerador é "a rotina
-- faturou o item do contrato na competência" — peça própria do contrato, não
-- coluna no item universal da ordem (DP6). Append-only por competência; a OS
-- cancelada devolve a competência (deleted='S') e a rotina revive a linha.
CREATE TABLE IF NOT EXISTS `tb_contract_item_competence` (
  `tb_institution_id` INT NOT NULL,
  `tb_contract_id`    INT NOT NULL,
  `tb_product_id`     INT NOT NULL,
  `competence`        CHAR(7) NOT NULL COMMENT 'YYYY-MM',
  `tb_order_id`       INT NOT NULL,
  `terminal`          INT NOT NULL DEFAULT 0,
  `tb_order_item_id`  INT NOT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_contract_id`, `tb_product_id`, `competence`),
  KEY `idx_contract_competence_order` (`tb_institution_id`, `tb_order_id`, `terminal`),
  CONSTRAINT `fk_contract_item_competence_item`
    FOREIGN KEY (`tb_contract_id`, `tb_institution_id`, `tb_product_id`)
    REFERENCES `tb_contract_item` (`tb_contract_id`, `tb_institution_id`, `tb_product_id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Backfill: itens de serviço VIVOS de OS de clientes com contrato, cujo produto é
-- item do contrato, viram fato da competência do mês em que nasceram (regra antiga,
-- só para não reinjetar o que já existe). INSERT IGNORE = idempotente; dois contratos
-- do mesmo cliente com o mesmo produto: o de menor id fica com o fato.
INSERT IGNORE INTO `tb_contract_item_competence`
  (`tb_institution_id`, `tb_contract_id`, `tb_product_id`, `competence`,
   `tb_order_id`, `terminal`, `tb_order_item_id`, `created_at`, `updated_at`, `deleted`)
SELECT i.tb_institution_id, ct.id, i.tb_product_id, DATE_FORMAT(i.created_at, '%Y-%m'),
       i.tb_order_id, i.terminal, i.id, NOW(), NOW(), 'N'
  FROM `tb_order_item` i
  INNER JOIN `tb_service_order` c
     ON c.id = i.tb_order_id AND c.tb_institution_id = i.tb_institution_id
    AND c.terminal = i.terminal AND c.deleted = 'N'
  INNER JOIN `tb_order_service` s
     ON s.id = c.id AND s.tb_institution_id = c.tb_institution_id AND s.terminal = c.terminal
  INNER JOIN `tb_contract` ct
     ON ct.tb_institution_id = i.tb_institution_id AND ct.tb_customer_id = s.tb_customer_id
    AND ct.deleted = 'N'
  INNER JOIN `tb_contract_item` ci
     ON ci.tb_contract_id = ct.id AND ci.tb_institution_id = ct.tb_institution_id
    AND ci.tb_product_id = i.tb_product_id AND ci.deleted = 'N'
 WHERE i.kind = 'Service' AND i.deleted = 'N' AND i.created_at IS NOT NULL
 ORDER BY ct.id;
