-- 062 — D-N19a (Valdo, 2026-09-28: a Setes é ME/EPP, opSimpNac 3).
--
-- regApTribSN do DPS (TSRegimeApuracaoSimpNac, opcional no XSD): para o optante ME/EPP que
-- ULTRAPASSOU sublimite/limite do Simples, em que regime os tributos federais e o municipal
-- estão sendo apurados. NULL = não ultrapassou (elemento omitido — o fisco apura pelo SN).
-- Fato do EMITENTE: vive em tb_entity_tax da institution (como opSimpNac/regEspTrib — 058).
ALTER TABLE `tb_entity_tax`
  ADD COLUMN IF NOT EXISTS `simples_assessment` CHAR(1) DEFAULT NULL
    COMMENT 'regApTribSN da DPS (só opSimpNac 3): 1 federais e municipal pelo SN · 2 federais pelo SN e ISSQN por fora · 3 federais e municipal por fora. NULL = dentro do sublimite (omitido)'
    AFTER `simples_regime`;
