-- 027 (CENTRAL) — kind tipado em tb_payment_types
-- Decisões 16/26/32: o kind classifica o COMPORTAMENTO DE QUITAÇÃO do meio —
-- fim do match por texto de descrição (QF3 do financeiro.md). Domínio COMPLETO
-- desde já (classificar ≠ implementar — cheque/cartão são onda 2, decisão 27):
--   'E' espécie (baixa à vista → caixa; a prazo não existe → vira carteira)
--   'X' PIX     (baixa à vista → conta corrente pré-cadastrada)
--   'Q' cheque  (baixa com o cheque — portador de dívida, decisão 17)
--   'B' boleto  (NUNCA baixa no nascimento — extrato/retorno/API, decisão 14)
--   'W' carteira/fiado (administração manual)
--   'C' cartão  (simples ou com contrato — onda 2)
--   'O' outros  (sem comportamento automático)
-- Backfill por MAPA DETERMINÍSTICO id_nfce → kind (decisão 32). NENHUMA
-- heurística de texto: última vez que algo além do kind classifica. Linha sem
-- id_nfce cai em 'O' para revisão pela tela do Super.
-- A tabela é CENTRAL: statements qualificados em setes_central e guardados por
-- information_schema — a migration roda por schema (runner) e precisa ser
-- idempotente entre schemas.

SET @kind_exists := (SELECT COUNT(*) FROM information_schema.columns
                      WHERE table_schema = 'setes_central'
                        AND table_name   = 'tb_payment_types'
                        AND column_name  = 'kind');

SET @ddl := IF(@kind_exists = 0,
  'ALTER TABLE `setes_central`.`tb_payment_types` ADD COLUMN `kind` char(1) DEFAULT NULL AFTER `id_nfce`',
  'SELECT 1');

PREPARE stmt_kind FROM @ddl;
EXECUTE stmt_kind;
DEALLOCATE PREPARE stmt_kind;

UPDATE `setes_central`.`tb_payment_types`
   SET `kind` = CASE `id_nfce`
                  WHEN '01' THEN 'E'
                  WHEN '17' THEN 'X'
                  WHEN '02' THEN 'Q'
                  WHEN '15' THEN 'B'
                  WHEN '05' THEN 'W'
                  WHEN '03' THEN 'C'
                  WHEN '04' THEN 'C'
                  ELSE 'O'
                END
 WHERE `kind` IS NULL;

ALTER TABLE `setes_central`.`tb_payment_types`
  MODIFY COLUMN `kind` char(1) NOT NULL DEFAULT 'O';
