-- =============================================================
-- Migration: 024_invoice_return_service_widen.sql
-- Implantação Setes (2026-08-14): o retorno de NFS-e real não cabe
-- no contrato — TB_RETORNO_NFS.NFS_COD_VERIF é VARCHAR(100) no
-- Firebird (prefeituras usam a própria chave da nota, 50+ chars) e
-- NFS_MOTIVO é VARCHAR(255). A web tinha 15/60 e o /invoice-return-
-- service 400ava a fila inteira ("quem aposenta se adapta" — D15/D22
-- da revisão do sincronizador: a web acompanha o tamanho do legado).
-- =============================================================

ALTER TABLE `tb_invoice_return_service`
  MODIFY `code_verif` VARCHAR(100) DEFAULT NULL,
  MODIFY `motive` VARCHAR(255) DEFAULT NULL;
