-- =============================================================
-- Migration: 017_crashlytics_central.sql
-- Framework de Mensagens R2 (Valdo, 2026-07-19): o rastro de erro técnico
-- vive em setes_central.tb_crashlytics (reformada — ref/code/status_code;
-- sql/01 + seed 21). A tb_crashlytics LOCAL do baseline (alimentada pelos
-- apps legados/Firebase) é DERRUBADA — o suporte consulta a central.
-- =============================================================

DROP TABLE IF EXISTS `tb_crashlytics`;
