-- =============================================================
-- Migration: 011_payment_types_central.sql
-- Formas de pagamento viram catálogo CENTRAL (Valdo, 2026-07-18):
-- setes_central.tb_payment_types compartilhada entre os clientes (o
-- cliente inicia o cadastro; existente = só vincula) + vínculo/uso em
-- setes_<schema>.tb_institution_has_payment_types (active/app_delivery).
--
-- MIGRAÇÃO DE DADOS (preserva o que o schema legado tinha):
--   1. Formas locais vivas sobem para a central POR DESCRIÇÃO (dedupe);
--   2. tb_customer.tb_payment_types_id é REMAPEADO para o id central;
--   3. Vínculos locais existentes são recriados apontando para a central;
--   4. A tb_payment_types LOCAL (baseline legado) é DERRUBADA e a has-table
--      é REALINHADA (FKs cross-schema — padrão fix-forward das 008/009/010).
--
-- DEPENDÊNCIA: setes_central.tb_payment_types precisa existir antes
-- (sql/01 — `npm run db:bootstrap`).
-- =============================================================

-- 1. Sobe as formas locais vivas para o catálogo central (dedupe por descrição)
INSERT INTO `setes_central`.`tb_payment_types`
  (`id`, `description`, `id_nfce`, `created_at`, `updated_at`, `deleted`)
SELECT (SELECT COALESCE(MAX(c2.id), 0) FROM `setes_central`.`tb_payment_types` c2)
         + ROW_NUMBER() OVER (ORDER BY l.id),
       l.description, l.id_nfce, NOW(), NOW(), 'N'
FROM `tb_payment_types` l
WHERE l.deleted = 'N' AND l.description IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `setes_central`.`tb_payment_types` c
                  WHERE c.description = l.description COLLATE utf8mb4_unicode_ci
                    AND c.deleted = 'N');

-- 2. Remapeia os clientes que apontavam para a forma LOCAL (join por descrição)
UPDATE `tb_customer` c
  JOIN `tb_payment_types` l ON l.id = c.tb_payment_types_id
  JOIN `setes_central`.`tb_payment_types` ct
    ON ct.description = l.description COLLATE utf8mb4_unicode_ci
   AND ct.deleted = 'N'
   SET c.tb_payment_types_id = ct.id, c.updated_at = NOW()
 WHERE c.tb_payment_types_id > 0;

-- 3. Preserva os vínculos existentes remapeados para o id central
CREATE TABLE `tb_ihpt_mig` AS
SELECT h.tb_institution_id, ct.id AS tb_payment_types_id,
       h.active, h.app_delivery
FROM `tb_institution_has_payment_types` h
  JOIN `tb_payment_types` l ON l.id = h.tb_payment_types_id
  JOIN `setes_central`.`tb_payment_types` ct
    ON ct.description = l.description COLLATE utf8mb4_unicode_ci
   AND ct.deleted = 'N'
WHERE h.deleted = 'N';

-- 4. Realinha: derruba as versões do baseline legado
DROP TABLE IF EXISTS `tb_institution_has_payment_types`;
DROP TABLE IF EXISTS `tb_payment_types`;

CREATE TABLE `tb_institution_has_payment_types` (
  `tb_institution_id`   INT NOT NULL,
  `tb_payment_types_id` INT NOT NULL,
  `active`              CHAR(1) NOT NULL DEFAULT 'S',
  `app_delivery`        CHAR(1) NOT NULL DEFAULT 'N',
  `created_at`          DATETIME DEFAULT NULL,
  `updated_at`          DATETIME DEFAULT NULL,
  `deleted`             CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_payment_types_id`),
  KEY `idx_ihpt_payment_types` (`tb_payment_types_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_ihpt_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_ihpt_payment_types` FOREIGN KEY (`tb_payment_types_id`) REFERENCES `setes_central`.`tb_payment_types` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

INSERT INTO `tb_institution_has_payment_types`
  (`tb_institution_id`, `tb_payment_types_id`, `active`, `app_delivery`,
   `created_at`, `updated_at`, `deleted`)
SELECT m.tb_institution_id, m.tb_payment_types_id,
       COALESCE(m.active, 'S'), COALESCE(m.app_delivery, 'N'),
       NOW(), NOW(), 'N'
FROM `tb_ihpt_mig` m;

DROP TABLE `tb_ihpt_mig`;
