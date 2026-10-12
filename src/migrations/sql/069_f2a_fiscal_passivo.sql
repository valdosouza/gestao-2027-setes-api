-- 069 — f2a_fiscal_passivo — F2a, etapa A3 (Infra-IA/prompts/prompt_apis_fiscais_isoladas.md §22.11; D-F110 = Q-F116 (a), Valdo
-- 2026-10-12, com a errata da numeração: o NOME é o fato — a nfse-api confere `_migrations.name = 'f2a_fiscal_passivo'` antes do ATO
-- da virada (D-F50); o número é o próximo livre na JANELA).
--
-- O ERP DEIXOU DE ESCREVER A VOZ FISCAL — por construção, não por procedimento. Depois da virada a voz do fisco é escrita SÓ pela
-- nfse-api no banco fiscal_api (D-F11/D-F39); as tabelas de tentativa e de voz do ERP viram ORIGEM CONGELADA (a re-sincronia final
-- do `migrate:setes` lê delas; a história fica — sem DROP: DROP = decisão futura). Gatilhos BEFORE com SIGNAL 45000:
--   - tb_invoice_service_transmission / _event: nenhum INSERT, UPDATE ou DELETE (o código da A3 não as toca — cerca na suíte);
--   - tb_establishment_issuer, linha SE (a habilitação que mudou de casa — D-F42/D-F44): sem INSERT de SE, sem revive S→N, sem mudar
--     `environment`, `dps_last_number` nem `model`, sem DELETE físico. N→S É PERMITIDO: é o ATO da virada (D-F44 — a única escrita de
--     uma API fiscal no ERP, `nfse-api/scripts/cutover-erp.ts`). As linhas 55/65 (só a SÉRIE da nota — D-F21/D-F112) seguem livres.
-- Ganhos (Rodada 1 da F2a): rollback de código pós-virada falha FECHADO (o ERP antigo tentaria escrever e o banco recusa), a lacuna (b)
-- fica inalcançável, a D-F56/D-F58 vira fato de banco, a re-sincronia lê origem que não muda. O ensaio da virada confere os gatilhos.
-- ASSUNÇÃO A-F110 (§22.11): a decisão nomeia INSERT/UPDATE; o DELETE físico também é recusado (o código nunca apaga — soft delete — e
-- uma linha apagada faria a re-sincronia acusar "fato que a origem não tem").
--
-- PADROES_BANCO §11 regra 15 (nova): gatilho de TRAVA = `SIGNAL SQLSTATE '45000'` com mensagem que cita a decisão; DROP IF EXISTS antes
-- do CREATE (re-executável: processo morto entre o DDL e o registro em _migrations não trava o próximo boot); corpo BEGIN/END em linhas
-- próprias (o runner divide por ';' fora do bloco); sem DELIMITER (o driver manda um comando por vez).

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Tentativas da NFS-e no ERP — origem congelada
-- ---------------------------------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `tg_f2a_freeze_tx_bi`;
CREATE TRIGGER `tg_f2a_freeze_tx_bi` BEFORE INSERT ON `tb_invoice_service_transmission`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): tentativa ao fisco e escrita so pela nfse-api (fiscal_api) - tabela do ERP congelada';
END;

DROP TRIGGER IF EXISTS `tg_f2a_freeze_tx_bu`;
CREATE TRIGGER `tg_f2a_freeze_tx_bu` BEFORE UPDATE ON `tb_invoice_service_transmission`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): tentativa ao fisco e escrita so pela nfse-api (fiscal_api) - tabela do ERP congelada';
END;

DROP TRIGGER IF EXISTS `tg_f2a_freeze_tx_bd`;
CREATE TRIGGER `tg_f2a_freeze_tx_bd` BEFORE DELETE ON `tb_invoice_service_transmission`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): origem congelada das tentativas ao fisco - nada se apaga';
END;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Voz do fisco no ERP — origem congelada
-- ---------------------------------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `tg_f2a_freeze_voice_bi`;
CREATE TRIGGER `tg_f2a_freeze_voice_bi` BEFORE INSERT ON `tb_invoice_service_transmission_event`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): a voz do fisco e escrita so pela nfse-api (fiscal_api) - tabela do ERP congelada';
END;

DROP TRIGGER IF EXISTS `tg_f2a_freeze_voice_bu`;
CREATE TRIGGER `tg_f2a_freeze_voice_bu` BEFORE UPDATE ON `tb_invoice_service_transmission_event`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): a voz do fisco e escrita so pela nfse-api (fiscal_api) - tabela do ERP congelada';
END;

DROP TRIGGER IF EXISTS `tg_f2a_freeze_voice_bd`;
CREATE TRIGGER `tg_f2a_freeze_voice_bd` BEFORE DELETE ON `tb_invoice_service_transmission_event`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): origem congelada da voz do fisco - nada se apaga';
END;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Habilitação SE do ERP — só o ATO da virada (N→S) escreve nela (D-F44)
-- ---------------------------------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `tg_f2a_freeze_issuer_se_bi`;
CREATE TRIGGER `tg_f2a_freeze_issuer_se_bi` BEFORE INSERT ON `tb_establishment_issuer`
FOR EACH ROW
BEGIN
  IF NEW.`model` = 'SE' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110/D-F44): a habilitacao SE e da nfse-api - o ERP nao cria linha SE';
  END IF;
END;

DROP TRIGGER IF EXISTS `tg_f2a_freeze_issuer_se_bu`;
CREATE TRIGGER `tg_f2a_freeze_issuer_se_bu` BEFORE UPDATE ON `tb_establishment_issuer`
FOR EACH ROW
BEGIN
  IF OLD.`model` = 'SE' OR NEW.`model` = 'SE' THEN
    IF NOT (NEW.`model` <=> OLD.`model`) OR NOT (NEW.`environment` <=> OLD.`environment`)
       OR NOT (NEW.`dps_last_number` <=> OLD.`dps_last_number`)
       OR (OLD.`deleted` = 'S' AND NEW.`deleted` <> 'S') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110/D-F44): habilitacao SE do ERP congelada - so o ato da virada a aposenta (N para S)';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS `tg_f2a_freeze_issuer_se_bd`;
CREATE TRIGGER `tg_f2a_freeze_issuer_se_bd` BEFORE DELETE ON `tb_establishment_issuer`
FOR EACH ROW
BEGIN
  IF OLD.`model` = 'SE' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110/D-F44): a historia da habilitacao SE fica - nada se apaga';
  END IF;
END;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. COMMENTs de aposentadoria (sem DROP) — a definição de cada coluna é a do schema aplicado (SHOW CREATE TABLE, 2026-10-12)
-- ---------------------------------------------------------------------------------------------------------------------------
ALTER TABLE `tb_invoice_service_transmission`
  COMMENT = 'ORIGEM CONGELADA (F2a, D-F110): as tentativas ao fisco moram no fiscal_api (nfse-api); historia anterior a virada';
ALTER TABLE `tb_invoice_service_transmission_event`
  COMMENT = 'ORIGEM CONGELADA (F2a, D-F110): a voz do fisco mora no fiscal_api (nfse-api); historia anterior a virada';
ALTER TABLE `tb_establishment_issuer`
  MODIFY `environment` char(1) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'H' COMMENT 'APOSENTADA no ERP (F2a, D-F110): o ambiente da emissao e da nfse-api (fiscal_api); aqui so historia',
  MODIFY `dps_last_number` int(11) NOT NULL DEFAULT 0 COMMENT 'APOSENTADA no ERP (F2a, D-F110): o contador do nDPS e da nfse-api (fiscal_api); aqui so historia';
ALTER TABLE `tb_invoice_service`
  MODIFY `dps_number` int(11) DEFAULT NULL COMMENT 'APOSENTADA (F2a, D-F30/D-F110): o nDPS da vida mora no fiscal_api (tb_invoice_service_dps); aqui so historia';
