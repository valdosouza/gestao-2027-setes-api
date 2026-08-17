-- 028 — Realinhamento tb_cashier.tb_userid → tb_user_id
-- Decisão 34 (fase Faturamento Fiscal e Financeiro, rodada de achados do DDL):
-- manter o padrão da casa (PADROES_BANCO §1: FK = tabela + _id). Mudança
-- COORDENADA: o contrato HTTP do /cashier NÃO carrega o nome da coluna (o
-- Delphi monta o payload com id/terminal/dtRecord/hrBegin/hrEnd/deleted/user —
-- verificado em cashier_send_web.pas), então o ajuste é só no banco + nos dois
-- endpoints web (setes-sync e setes-api sync legado), no MESMO deploy desta
-- migration. Guardada por information_schema para ser idempotente.

SET @old_exists := (SELECT COUNT(*) FROM information_schema.columns
                     WHERE table_schema = DATABASE()
                       AND table_name   = 'tb_cashier'
                       AND column_name  = 'tb_userid');

SET @ddl := IF(@old_exists = 1,
  'ALTER TABLE `tb_cashier` CHANGE COLUMN `tb_userid` `tb_user_id` int(11) DEFAULT NULL',
  'SELECT 1');

PREPARE stmt_cashier FROM @ddl;
EXECUTE stmt_cashier;
DEALLOCATE PREPARE stmt_cashier;
