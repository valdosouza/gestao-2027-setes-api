-- 047 — Ciclo da ORDEM DE SERVIÇO ganha ramo próprio: `tb_service_order`
-- (prompt_cancelamento_nota.md §10.9 — D-G11/Q-G18 "concordo... ramo próprio",
-- Valdo 2026-09-09; parecer setes-conceito: natureza por PRESENÇA ×
-- processo por ATO).
--
-- `tb_order_service` é ramo COMPARTILHADO por natureza: nasce na venda com
-- item de serviço (orders), no pedido sincronizado (setes-sync) e na OS.
-- O CICLO da OS (abrir → itens/rotina mensal → faturar → cancelar a nota
-- reabre) só tem UM produtor: o módulo service-orders. Migram para cá a trava
-- D5 (`open_lock`, UNIQUE — 1 OS aberta por cliente) e o nº da OS; o tomador
-- (`tb_customer_id`) FICA na natureza (é o que billing/settlements/bank-slips
-- leem). Herança em dois níveis: Order → OrderService → ServiceOrder (FK).
--
-- CARGA (identidade única, retroativa): pedido da WEB (`tb_order.origin IS
-- NULL` — o sync grava origin, a web nunca) SEM ramo de venda. Cobre OS
-- abertas, faturadas e canceladas. CONFERÊNCIA antes de aplicar em produção
-- (roteiro Q-G14):
--   SELECT o.origin, EXISTS(SELECT 1 FROM tb_order_sale os WHERE os.id=s.id
--          AND os.tb_institution_id=s.tb_institution_id AND os.terminal=s.terminal) temSale,
--          s.deleted, SUM(s.open_lock IS NOT NULL) abertas, COUNT(*) n
--     FROM tb_order_service s JOIN tb_order o ON o.id=s.id AND o.tb_institution_id=s.tb_institution_id
--      AND o.terminal=s.terminal GROUP BY o.origin, temSale, s.deleted;
--   → só a linha (origin NULL, temSale 0) migra; nenhuma OUTRA linha pode ter open_lock.
--   Ainda (L5 do gate socrático): nessa linha, `s.number IS NULL` deve ser 0 (OS web sem nº
--   NÃO migra em silêncio) e (tb_institution_id, number) não pode repetir (uk_service_order_number
--   abortaria o INSERT — idempotente, mas exige mão):
--   SELECT SUM(s.number IS NULL) semNumero, COUNT(*) - COUNT(DISTINCT s.tb_institution_id, s.number) duplicados
--     FROM tb_order_service s JOIN tb_order o ON o.id=s.id AND o.tb_institution_id=s.tb_institution_id
--      AND o.terminal=s.terminal WHERE o.origin IS NULL AND NOT EXISTS (SELECT 1 FROM tb_order_sale os
--     WHERE os.id=s.id AND os.tb_institution_id=s.tb_institution_id AND os.terminal=s.terminal);
-- Depois da carga: `number`/`open_lock` das linhas movidas e o `number` cunhado
-- para VENDAS web (nunca exibido — a lista de pedidos lê tb_order_sale.number)
-- viram NULL na natureza; a UNIQUE da trava sai da natureza. A COLUNA
-- `open_lock` fica na natureza até o setes-sync parar de gravá-la (Q-C4 —
-- deploy casado; migration futura dropa a coluna). Idempotente.

CREATE TABLE IF NOT EXISTS `tb_service_order` (
  `id`                INT NOT NULL,
  `tb_institution_id` INT NOT NULL,
  `terminal`          INT NOT NULL DEFAULT 0,
  `number`            INT NOT NULL COMMENT 'nº da OS (MAX+1 por institution)',
  `open_lock`         VARCHAR(30) DEFAULT NULL COMMENT 'trava D5 "<inst>-<cliente>" mantida pela app; NULL = faturada/cancelada',
  `created_at`        DATETIME NOT NULL,
  `updated_at`        DATETIME NOT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`, `terminal`),
  UNIQUE KEY `uk_service_order_open`   (`open_lock`),
  UNIQUE KEY `uk_service_order_number` (`tb_institution_id`, `number`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_tb_service_order_service`
    FOREIGN KEY (`id`, `tb_institution_id`, `terminal`)
    REFERENCES `tb_order_service` (`id`, `tb_institution_id`, `terminal`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

INSERT INTO `tb_service_order`
  (`id`, `tb_institution_id`, `terminal`, `number`, `open_lock`, `created_at`, `updated_at`, `deleted`)
SELECT s.`id`, s.`tb_institution_id`, s.`terminal`, s.`number`, s.`open_lock`,
       s.`created_at`, s.`updated_at`, s.`deleted`
  FROM `tb_order_service` s
  JOIN `tb_order` o
    ON o.`id` = s.`id` AND o.`tb_institution_id` = s.`tb_institution_id` AND o.`terminal` = s.`terminal`
 WHERE o.`origin` IS NULL AND s.`number` IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM `tb_order_sale` os
                    WHERE os.`id` = s.`id` AND os.`tb_institution_id` = s.`tb_institution_id`
                      AND os.`terminal` = s.`terminal`)
   AND NOT EXISTS (SELECT 1 FROM `tb_service_order` c
                    WHERE c.`id` = s.`id` AND c.`tb_institution_id` = s.`tb_institution_id`
                      AND c.`terminal` = s.`terminal`);

UPDATE `tb_order_service` s
  JOIN `tb_service_order` c
    ON c.`id` = s.`id` AND c.`tb_institution_id` = s.`tb_institution_id` AND c.`terminal` = s.`terminal`
   SET s.`number` = NULL, s.`open_lock` = NULL, s.`updated_at` = NOW()
 WHERE s.`number` IS NOT NULL OR s.`open_lock` IS NOT NULL;

UPDATE `tb_order_service` s
  JOIN `tb_order` o
    ON o.`id` = s.`id` AND o.`tb_institution_id` = s.`tb_institution_id` AND o.`terminal` = s.`terminal`
   SET s.`number` = NULL, s.`updated_at` = NOW()
 WHERE o.`origin` IS NULL AND s.`number` IS NOT NULL
   AND EXISTS (SELECT 1 FROM `tb_order_sale` os
                WHERE os.`id` = s.`id` AND os.`tb_institution_id` = s.`tb_institution_id`
                  AND os.`terminal` = s.`terminal`);

ALTER TABLE `tb_order_service` DROP INDEX IF EXISTS `uk_open_per_customer`;
