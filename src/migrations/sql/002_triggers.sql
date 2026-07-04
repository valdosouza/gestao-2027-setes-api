-- =============================================================
-- Migration: 002_triggers.sql
-- Triggers do schema real Setes
-- =============================================================

DROP TRIGGER IF EXISTS `after_stock_statement_insert`;

CREATE TRIGGER `after_stock_statement_insert`
AFTER INSERT ON `tb_stock_statement`
FOR EACH ROW
BEGIN
  IF NEW.direction = 'S' THEN
    UPDATE tb_stock_balance sb SET
      sb.quantity = sb.quantity - NEW.quantity
    WHERE (sb.tb_institution_id = NEW.tb_institution_id)
      AND (sb.tb_stock_list_id = NEW.tb_stock_list_id)
      AND (sb.tb_merchandise_id = NEW.tb_merchandise_id);
  END IF;
  IF NEW.direction = 'E' THEN
    UPDATE tb_stock_balance sb SET
      sb.quantity = sb.quantity + NEW.quantity
    WHERE (sb.tb_institution_id = NEW.tb_institution_id)
      AND (sb.tb_stock_list_id = NEW.tb_stock_list_id)
      AND (sb.tb_merchandise_id = NEW.tb_merchandise_id);
  END IF;
END;

DROP TRIGGER IF EXISTS `whatsapp_has_contact_ime_trigger`;

CREATE TRIGGER `whatsapp_has_contact_ime_trigger`
BEFORE UPDATE ON `tb_whatsapp_has_contact`
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP;
END;
