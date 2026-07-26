-- =============================================================
-- Migration: 005_entidade_unica.sql
-- Fase 3 (Entidade Única) — prompt_fase3_entidade_unica.md, decisão 12
-- Alinha o schema do cliente ao MODELO CENTRAL de entidades:
--   1. tb_customer/tb_salesman/tb_carrier passam a apontar FKs para
--      setes_central (tb_entity / tb_institution) — antes apontavam para
--      cópias LOCAIS herdadas do baseline legado (001).
--   2. Remove as cópias locais da cadeia de entidade (tb_entity, tb_person,
--      tb_company, tb_address, tb_phone, tb_social_media, tb_mailing*,
--      tb_linebusiness) — absorve o núcleo cadastral do antigo
--      sql/04_schema_cliente_cleanup.sql no pipeline automático.
--
-- ⚠️ O QUE NÃO CAI AQUI (anotado para a revisão do sync — decisão 12):
--   - tb_user e tb_institution locais: 14+3 tabelas operacionais do legado
--     ainda têm FK para elas (tb_product, tb_order, tb_category...). Caem na
--     fase de integração do sync, quando os ids do Firebird forem
--     REINDEXADOS via cpf/cnpj ou tb_no_doc.external_id (no Firebird não há
--     entity; o objeto enviado não se parece com as tabelas de origem).
--   - Endpoints /sync que gravavam nas cópias locais (customer, ordersale...)
--     ficam quebrados para entity até essa revisão — esperado e aceito.
--   - tb_user local fica com FK pendurada para tb_entity (nada grava nela).
-- =============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------
-- 1. tb_customer — FKs realinhadas para a central (+ carrier, que faltava)
-- ---------------------------------------------------------------
ALTER TABLE `tb_customer` DROP FOREIGN KEY `tb_customer_ibfk_1`;
ALTER TABLE `tb_customer` DROP FOREIGN KEY `tb_customer_ibfk_2`;
ALTER TABLE `tb_customer`
  ADD CONSTRAINT `fk_tb_customer_entity`
    FOREIGN KEY (`id`) REFERENCES `setes_central`.`tb_entity` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_tb_customer_institution`
    FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_tb_customer_salesman`
    FOREIGN KEY (`tb_salesman_id`) REFERENCES `setes_central`.`tb_entity` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD KEY `idx_tb_customer_carrier` (`tb_carrier_id`),
  ADD CONSTRAINT `fk_tb_customer_carrier`
    FOREIGN KEY (`tb_carrier_id`) REFERENCES `setes_central`.`tb_entity` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------
-- 2. tb_salesman — FKs realinhadas para a central (decisão 11)
-- ---------------------------------------------------------------
ALTER TABLE `tb_salesman` DROP FOREIGN KEY `tb_salesman_ibfk_1`;
ALTER TABLE `tb_salesman` DROP FOREIGN KEY `tb_salesman_ibfk_2`;
ALTER TABLE `tb_salesman`
  ADD CONSTRAINT `fk_tb_salesman_entity`
    FOREIGN KEY (`id`) REFERENCES `setes_central`.`tb_entity` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_tb_salesman_institution`
    FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------
-- 3. tb_carrier — ganha as FKs que nunca teve (decisão 11)
-- ---------------------------------------------------------------
ALTER TABLE `tb_carrier`
  ADD CONSTRAINT `fk_tb_carrier_entity`
    FOREIGN KEY (`id`) REFERENCES `setes_central`.`tb_entity` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_tb_carrier_institution`
    FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------
-- 4. Remoção das cópias locais da cadeia de entidade (decisão 12)
--    Ordem: filhas antes de tb_entity.
-- ---------------------------------------------------------------
DROP TABLE IF EXISTS `tb_entity_has_mailing`;
DROP TABLE IF EXISTS `tb_mailing`;
DROP TABLE IF EXISTS `tb_mailing_group`;
DROP TABLE IF EXISTS `tb_social_media`;
DROP TABLE IF EXISTS `tb_phone`;
DROP TABLE IF EXISTS `tb_address`;
DROP TABLE IF EXISTS `tb_person`;
DROP TABLE IF EXISTS `tb_company`;
DROP TABLE IF EXISTS `tb_entity`;
DROP TABLE IF EXISTS `tb_linebusiness`;
DROP TABLE IF EXISTS `tb_line_business`;

SET FOREIGN_KEY_CHECKS = 1;
