-- 067 — Rodada 13 das APIs fiscais (Infra-IA/prompts/prompt_apis_fiscais_isoladas.md §8.R12/§21.7;
-- parecer do guardião conferido, Valdo 2026-10-10 "Sim, siga tudo"):
--
-- D-F71 (= Q-F78): o CÓDIGO do evento de cancelamento do fisco vira FATO estruturado na voz C — reusa
--   `authority_code` (já existe, VARCHAR(10), era só o E0xxx das rejeições). Texto livre não é contrato:
--   a marca de SUBSTITUIÇÃO (e105102) deixa de ser lida da mensagem.
-- D-F75 (= Q-F82): o código só SOBE para 105102, nunca volta (a peça promove; aqui só o backfill).
-- D-F67/D-F74 (= Q-F74 (a)/Q-F81): o ato humano "manter a nota" diante de uma NFS-e SUBSTITUÍDA no
--   fisco é FATO próprio da NOTA (`tb_invoice_cancel_waiver`), não coluna da voz: a voz é do fisco, a
--   decisão é de uma pessoa. Só existe para e105102 (a peça recusa os demais). Chave da substituta NÃO
--   tem coluna (D-F76 — derivada do XML do evento, só exibição).
--
-- Re-executável (o runner não tem transação): UPDATE idempotente, MODIFY, ADD CONSTRAINT IF NOT EXISTS,
-- CREATE TABLE IF NOT EXISTS.

-- 1. Backfill do código nas vozes C já gravadas: a suspensão da D-F64 escreveu "(e105102)" no texto;
--    as vozes C de resposta DIRETA ao nosso pedido (source P) são sempre e101101 (o único evento que o
--    produto pede) — a marca de texto só vale para voz de CONSULTA (R13-02 do gate adversarial: o motivo DIGITADO
--    no nosso pedido pode conter o texto). C de consulta sem a marca fica NULL (código desconhecido — o CHECK aceita).
UPDATE `tb_invoice_service_transmission_event`
   SET `authority_code` = '105102', `updated_at` = UTC_TIMESTAMP()
 WHERE `kind` = 'C' AND `authority_code` IS NULL AND `source` <> 'P' AND `message` LIKE '%(e105102)%';

UPDATE `tb_invoice_service_transmission_event`
   SET `authority_code` = '101101', `updated_at` = UTC_TIMESTAMP()
 WHERE `kind` = 'C' AND `authority_code` IS NULL AND `source` = 'P';

ALTER TABLE `tb_invoice_service_transmission_event`
  MODIFY `authority_code` VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL
    COMMENT 'Código cru do fisco: E0xxx/HTTP nas rejeições · na voz C, o tipo do evento de cancelamento (101101 · 105102 substituição · 105104 · 305101 — D-F71)';

-- 2. Domínio do código NA VOZ C (D-IB26 / PADROES: domínio por CHECK) — as demais vozes seguem livres.
ALTER TABLE `tb_invoice_service_transmission_event`
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_transmission_event_cancel_code`
    CHECK (`kind` <> 'C' OR `authority_code` IS NULL OR `authority_code` IN ('101101', '105102', '105104', '305101'));

-- 3. "Manter a nota" (D-F67/D-F72/D-F73/D-F74): uma decisão por (nota, chave da NFS-e substituída).
--    Append-only na prática (sem rota de desfazer — soft delete reservado); autoria e motivo obrigatórios.
CREATE TABLE IF NOT EXISTS `tb_invoice_cancel_waiver` (
  `tb_institution_id` INT NOT NULL,
  `tb_invoice_id`     INT NOT NULL COMMENT 'tb_invoice.id (= id do pedido)',
  `terminal`          INT NOT NULL DEFAULT 0,
  `access_key`        VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL
    COMMENT 'Chave da NFS-e cancelada por SUBSTITUIÇÃO no fisco (a transmissão que a detém)',
  `reason`            VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL
    COMMENT 'Motivo de manter a nota (obrigatório — D-F73)',
  `tb_user_id`        INT NOT NULL COMMENT 'Quem decidiu (privilégio CANCELAR do ramo — D-F72)',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `access_key`),
  CONSTRAINT `ck_invoice_cancel_waiver_access_key` CHECK (`access_key` REGEXP '^[0-9A-Z]{44}([0-9A-Z]{6})?$'),
  CONSTRAINT `fk_invoice_cancel_waiver_invoice`
    FOREIGN KEY (`tb_invoice_id`, `tb_institution_id`, `terminal`)
    REFERENCES `tb_invoice` (`id`, `tb_institution_id`, `terminal`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
