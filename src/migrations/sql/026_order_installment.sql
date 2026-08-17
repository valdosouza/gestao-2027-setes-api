-- 026 — Parcelamento elaborado da ordem (fase Faturamento Fiscal e Financeiro)
-- Decisão 25 (materialização única): a via SIMPLES da negociação já vive em
-- tb_order_billing (tb_payment_types_id + plots + deadline string '028/056/084'
-- — decisão 31: string livre, sem catálogo). Esta tabela é SÓ o parcelamento
-- ELABORADO: PRESENÇA = negociação parcela a parcela; AUSÊNCIA = o prazo do
-- billing GERA as parcelas no faturamento. O financeiro NUNCA lê o prazo —
-- consome sempre o parcelamento materializado (em tb_financial, decisão 29).
-- PK espelha tb_financial (tb_institution_id, tb_order_id, terminal, parcel).

CREATE TABLE IF NOT EXISTS `tb_order_installment` (
  `tb_institution_id`    int(11) NOT NULL,
  `tb_order_id`          int(11) NOT NULL,
  `terminal`             int(11) NOT NULL DEFAULT 0,
  `parcel`               smallint NOT NULL,
  `due_date`             date NOT NULL,
  `amount`               decimal(15,2) NOT NULL,
  `tb_payment_types_id`  int(11) DEFAULT NULL,
  `created_at`           datetime DEFAULT NULL,
  `updated_at`           datetime DEFAULT NULL,
  `deleted`              char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_order_id`,`terminal`,`parcel`),
  CONSTRAINT `fk_order_installment_order` FOREIGN KEY (`tb_order_id`,`tb_institution_id`,`terminal`) REFERENCES `tb_order` (`id`,`tb_institution_id`,`terminal`),
  CONSTRAINT `fk_order_installment_paytype` FOREIGN KEY (`tb_payment_types_id`) REFERENCES `setes_central`.`tb_payment_types` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- tb_payment_types_id NULL = parcela herda a forma do billing da ordem;
-- preenchido = forma negociada POR PARCELA (caso elaborado).
