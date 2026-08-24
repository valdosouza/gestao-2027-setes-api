-- 032 — Imposto aproximado por item (P11/Fc_Obs_ImpostoAproximado do
-- tributacao.md, motor de observações fiscais, rodada Observações 2026-08-22).
--
-- Port do TB_ITENS_NFL.ITF_IMP_APROX do legado: percentual TOTAL aproximado
-- (nacional/importado + estadual + municipal, somados) calculado por NCM na
-- tabela central `setes_central.tb_ncm` (aliq_nac/aliq_imp/aliq_est/aliq_mun
-- — já existe, catálogo IBPT sem produtor até aqui). Persistido em
-- tb_order_item_tax_rule por decisão do Valdo — a tabela que a Onda 3 (R4)
-- criou para registrar como cada item foi tributado é o lugar natural para
-- também registrar o percentual aproximado usado, sem precisar de tabela
-- nova (Lei da Transparência é OUTRA faceta do mesmo item já tributado).

ALTER TABLE `tb_order_item_tax_rule`
  ADD COLUMN `approx_tax_aliq` decimal(10,4) DEFAULT NULL
    COMMENT 'Percentual aproximado total (Lei 12.741/2012) — nac/imp + est + mun somados, resolvido por NCM em setes_central.tb_ncm'
    AFTER `set_financial`;
