-- 031 — Regra de tributação POR ITEM da ordem (fase Faturamento Fiscal e
-- Financeiro, W2 Onda 3 — rodada R4 do prompt_fase_faturamento_financeiro.md).
--
-- Port da TB_ITENS_NFL_TRIBUTACAO do legado (P2.6b do tributacao.md — a
-- escolha de regra POR ITEM é o gatilho do modo RegraDireta), com o papel
-- AMPLIADO pela decisão R4 do Valdo: além da escolha MANUAL do cliente
-- (origin 'M'), a VALIDAÇÃO do faturamento grava aqui a regra que o motor
-- encontrou (origin 'A') — o faturamento consome a regra gravada sem
-- rebuscar, matando a dupla checagem do legado.
--
-- Regra de escrita: origin='A' é REGRAVADA a cada /billing/validate (sempre
-- re-resolve — imune a regra/item editados no meio); origin='M' NUNCA é
-- sobrescrita pela validação (escolha do cliente = sutileza 6 do motor).
--
-- PK inclui o `kind` do item (correção sobre o legado — tb_order_item tem
-- kind na PK; sem ele, item Sale e Service com mesmo id colidiriam).
-- set_financial: port do SET_FINANCIAL ("este item gera financeiro?" —
-- TEMFINANCEIRO nas telas do legado); a materialização do financeiro exclui
-- itens com 'N'.

CREATE TABLE IF NOT EXISTS `tb_order_item_tax_rule` (
  `tb_order_id`        int(11) NOT NULL,
  `tb_order_item_id`   int(11) NOT NULL,
  `tb_institution_id`  int(11) NOT NULL,
  `terminal`           int(11) NOT NULL DEFAULT 0,
  `kind`               varchar(50) NOT NULL DEFAULT 'Sale',
  `tb_tax_rule_id`     int(11) NOT NULL,
  `tb_cfop_id`         varchar(10) DEFAULT NULL,
  `set_financial`      char(1) NOT NULL DEFAULT 'S',
  `origin`             char(1) NOT NULL,
  `created_at`         datetime DEFAULT NULL,
  `updated_at`         datetime DEFAULT NULL,
  `deleted`            char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`,`tb_order_item_id`,`tb_institution_id`,`terminal`,`kind`),
  KEY `idx_oitr_rule` (`tb_institution_id`,`tb_tax_rule_id`),
  CONSTRAINT `fk_oitr_order` FOREIGN KEY (`tb_order_id`,`tb_institution_id`,`terminal`)
    REFERENCES `tb_order` (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- origin: 'M'anual (cliente escolheu na tela do item — modo RegraDireta) |
--         'A'utomatic (gravada pela validação do faturamento).
-- FK de tb_tax_rule_id não é física por escolha: regra soft-deletada depois
-- da validação é detectada no faturamento (revalida existência), e o DELETE
-- da regra não pode ser bloqueado por resíduo de validação antiga.
