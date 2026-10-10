-- 066 — Fase IBS/CBS, IB-1: classificação do SERVIÇO e colunas congeladas na NFS-e.
-- Decisões: D-IB6 (NBS + classificação do serviço), D-IB9 (congelamento no ramo), D-IB22 (FK ao
-- CÓDIGO do cClassTrib), D-IB25 (collation por coluna), D-IB26 (domínios por CHECK — as referências
-- centrais já carregam os CHECKs) — Infra-IA/prompts/prompt_fase_ibs_cbs.md §8/§10.5.
-- Guardião + revisar-ddl: §10.3 (B1 re-executável; erro legível sem as referências; collation).
--
-- PRÉ-REQUISITO: sql/61_ibscbs_reference_ddl.sql aplicado em setes_central (checklist de deploy).
-- O enquadramento datado do emitente (tb_establishment_tax_regime — D-IB7) NÃO entra aqui: nasce na
-- IB-2 junto com a troca dos dois leitores (fiscal-api/src/erp/facts.ts e a cópia do dual-run no
-- setes-api), sem dois escritores (parecer do guardião §10.3 (d)).
-- MariaDB 10.4: ADD COLUMN IF NOT EXISTS / FOREIGN KEY IF NOT EXISTS / CREATE TABLE IF NOT EXISTS
-- (re-executável comando a comando — o runner recomeça a migration inteira se ela falhar no meio).

-- 0. Referências centrais presentes? Falta = erro 1146 com o NOME da tabela (nunca errno 150).
SELECT 1 FROM `setes_central`.`tb_nbs` LIMIT 0;
SELECT 1 FROM `setes_central`.`tb_tax_ibscbs_classification` LIMIT 0;
SELECT 1 FROM `setes_central`.`tb_ibscbs_place_indicator` LIMIT 0;

-- 1. Natureza do serviço: NBS no serviço (espelho do ncm da mercadoria). tb_service é unicode_ci.
ALTER TABLE `tb_service`
  ADD COLUMN IF NOT EXISTS `nbs` CHAR(9) DEFAULT NULL
    COMMENT 'NBS do serviço (setes_central.tb_nbs.code) — cNBS do DPS (D-IB6)'
    AFTER `tb_service_tax_rule_id`;
ALTER TABLE `tb_service`
  ADD CONSTRAINT `fk_service_nbs` FOREIGN KEY IF NOT EXISTS (`nbs`)
    REFERENCES `setes_central`.`tb_nbs` (`code`);

-- 2. Classificação que o SERVIÇO presume (peça 1:1; presença = "o serviço está classificado").
--    FK física ao CÓDIGO (D-IB22); a vigência e a aplicabilidade na NFS-e são conferidas pela peça
--    @shared/ibscbs-classification na data do fato.
CREATE TABLE IF NOT EXISTS `tb_service_ibscbs` (
  `id`                    INT(11) NOT NULL COMMENT 'tb_service.id',
  `tb_institution_id`     INT(11) NOT NULL,
  `classification_code`   CHAR(6) NOT NULL COMMENT 'cClassTrib escolhido (CST derivado = prefixo)',
  `place_indicator_code`  CHAR(6) NOT NULL COMMENT 'cIndOp escolhido (o Anexo VIII só sugere)',
  `tb_user_id`            INT(11) DEFAULT NULL,
  `created_at`            DATETIME DEFAULT NULL,
  `updated_at`            DATETIME DEFAULT NULL,
  `deleted`               CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  KEY `idx_service_ibscbs_classification` (`classification_code`),
  KEY `idx_service_ibscbs_place` (`place_indicator_code`),
  CONSTRAINT `fk_service_ibscbs_service` FOREIGN KEY (`id`, `tb_institution_id`)
    REFERENCES `tb_service` (`id`, `tb_institution_id`),
  CONSTRAINT `fk_service_ibscbs_classification` FOREIGN KEY (`classification_code`)
    REFERENCES `setes_central`.`tb_tax_ibscbs_classification` (`code`),
  CONSTRAINT `fk_service_ibscbs_place` FOREIGN KEY (`place_indicator_code`)
    REFERENCES `setes_central`.`tb_ibscbs_place_indicator` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Classificação que a NFS-e DECLARA — congelada no ramo no faturamento (D-IB9; CST e indDest
--    são derivados). tb_invoice_service é general_ci (baseline): as colunas novas nascem unicode_ci
--    POR COLUNA (D-IB25 — o par natural de JOIN é o catálogo central). Sem FK: snapshot histórico.
ALTER TABLE `tb_invoice_service`
  ADD COLUMN IF NOT EXISTS `classification_code` CHAR(6) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL
    COMMENT 'cClassTrib congelado no faturamento (D-IB9)' AFTER `liability`,
  ADD COLUMN IF NOT EXISTS `place_indicator_code` CHAR(6) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL
    COMMENT 'cIndOp congelado no faturamento (D-IB9)' AFTER `classification_code`,
  ADD COLUMN IF NOT EXISTS `nbs` CHAR(9) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL
    COMMENT 'NBS congelada no faturamento (cNBS do DPS)' AFTER `place_indicator_code`;

-- 4. FORMATO das colunas congeladas (D-IB26 — gate socrático da IB-1): snapshot sem FK por desenho,
--    num servidor SEM modo estrito; o CHECK é a guarda contra a carga/SQL direto e contra o congelador
--    da IB-2 gravar lixo (NULL = nota sem classificação — o legado e as notas anteriores à fase).
--    ADD CONSTRAINT IF NOT EXISTS: re-executável (provado em banco descartável — MariaDB 10.4).
ALTER TABLE `tb_invoice_service`
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_classification_code`
    CHECK (`classification_code` IS NULL OR `classification_code` REGEXP '^[0-9]{6}$'),
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_place_indicator_code`
    CHECK (`place_indicator_code` IS NULL OR `place_indicator_code` REGEXP '^[0-9]{6}$'),
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_nbs`
    CHECK (`nbs` IS NULL OR `nbs` REGEXP '^[0-9]{9}$');
