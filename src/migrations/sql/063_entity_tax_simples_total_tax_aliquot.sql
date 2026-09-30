-- 063 — Q-N37 (Valdo, 2026-09-29): total aproximado de tributos da NFS-e (Lei 12.741) do ME/EPP.
--
-- A 1ª sessão em PRODUÇÃO devolveu E0712: para ME/EPP (opSimpNac 3) o DPS NUNCA pode levar
-- `indTotTrib` ("não informo") — tem de declarar o total aproximado. Escolha (Q-N37): `pTotTribSN`,
-- o percentual aproximado da alíquota do Simples = alíquota EFETIVA do DAS (PGDAS-D; muda com o
-- RBT12 — o contador informa). Fato do EMITENTE, irmão de simples_regime/simples_assessment em
-- tb_entity_tax (058/062). O valor de cada nota fica congelado no DPS transmitido (disco).
-- TSDec2V2 do XSD: até 99,99. NULL fora do regime 3 (MEI declara indTotTrib; não optante ainda
-- não suportado — E0713 exige valor/percentual por esfera, decisão com o 1º cliente assim).
ALTER TABLE `tb_entity_tax`
  ADD COLUMN IF NOT EXISTS `simples_total_tax_aliquot` DECIMAL(5,2) DEFAULT NULL
    COMMENT 'pTotTribSN da DPS (só opSimpNac 3, obrigatório): % aproximado da alíquota efetiva do Simples (DAS). Q-N37'
    AFTER `simples_assessment`;
