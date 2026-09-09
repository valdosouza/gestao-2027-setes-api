-- 042 — História da nota fiscal (Infra-IA/prompts/prompt_cancelamento_nota.md,
-- Rodada 1 D1–D17 + parecer setes-conceito, Valdo 2026-09-08).
--
-- Conceito: a nota é um DOCUMENTO com história — cada fato é um evento
-- append-only e o estado é DERIVADO do último (irmã de tb_check_event e
-- tb_bank_slip_event). Onda 1 conhece dois fatos:
--   E emitida   — nasce no faturamento, dentro da peça @shared/invoice
--   C cancelada — motivo obrigatório; aponta o E desfeito (origin_event)
-- Reservados para a fase de transmissão: T transmitida · A autorizada ·
-- R rejeitada · D denegada · I inutilizada (colunas SEFAZ — protocolo,
-- cStat, recibo — agregam por ADD COLUMN quando essa fase nascer).
-- NUNCA 'X': na casa X é meta-evento de estorno (cheque/boleto).
--
-- Snapshot do fato no E (number/serie/model/value): com D3 (nota pendente
-- cancelada = soft-delete) + D5 (pedido refaturável) o cabeçalho tb_invoice
-- (PK = id do pedido) é REVIVIDO e sobrescrito no refaturamento — a memória
-- de "nota 100 cancelada por X" vive só no evento.
--
-- Sem settled_code: sob D2 o C nunca move dinheiro por si; quem move (X do
-- cheque, estorno de statement) carrega o próprio código.

CREATE TABLE IF NOT EXISTS `tb_invoice_event` (
  `tb_institution_id` INT NOT NULL,
  `tb_invoice_id`     INT NOT NULL COMMENT 'tb_invoice.id (= id do pedido)',
  `terminal`          INT NOT NULL DEFAULT 0,
  `event`             INT NOT NULL,
  `kind`              CHAR(1) NOT NULL COMMENT 'E emitida · C cancelada · reservados T A R D I',
  `dt_record`         DATE NOT NULL,
  `number`            VARCHAR(20) DEFAULT NULL COMMENT 'Snapshot do fato (E)',
  `serie`             VARCHAR(10) DEFAULT NULL,
  `model`             VARCHAR(2) DEFAULT NULL,
  `value`             DECIMAL(10,2) DEFAULT NULL,
  `origin_event`      INT DEFAULT NULL COMMENT 'C: o E desfeito',
  `note`              VARCHAR(255) DEFAULT NULL COMMENT 'C: motivo (obrigatório na peça)',
  `tb_user_id`        INT DEFAULT NULL COMMENT 'NULL = retroativo (autor desconhecido)',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `event`),
  CONSTRAINT `fk_invoice_event_invoice`
    FOREIGN KEY (`tb_invoice_id`, `tb_institution_id`, `terminal`)
    REFERENCES `tb_invoice` (`id`, `tb_institution_id`, `terminal`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Backfill (Q-P1): evento E retroativo para toda nota da WEB (status '0' =
-- pronta, não transmitida) viva e ainda sem história. Nota sincronizada do
-- legado (outro produtor) fica SEM evento — e por isso NÃO é cancelável na
-- web ("cancele na origem").
INSERT INTO `tb_invoice_event`
  (`tb_institution_id`, `tb_invoice_id`, `terminal`, `event`, `kind`, `dt_record`,
   `number`, `serie`, `model`, `value`, `origin_event`, `note`, `tb_user_id`,
   `created_at`, `updated_at`, `deleted`)
SELECT i.`tb_institution_id`, i.`id`, i.`terminal`, 1, 'E', i.`dt_emission`,
       i.`number`, i.`serie`, i.`model`, i.`value`, NULL, 'retroativo', NULL,
       NOW(), NOW(), 'N'
  FROM `tb_invoice` i
 WHERE i.`status` = '0' AND i.`deleted` = 'N'
   AND NOT EXISTS (SELECT 1 FROM `tb_invoice_event` e
                    WHERE e.`tb_institution_id` = i.`tb_institution_id`
                      AND e.`tb_invoice_id` = i.`id` AND e.`terminal` = i.`terminal`);
