-- 050 — Desconto da baixa gravado em VALOR (D-G28 = Q-A21, Valdo 2026-09-10;
-- regra BX-10 do legado: "baixa parcial gera título residual" cuja FACE é o que
-- resta — o desconto de cada baixa incide sobre o SALDO EM ABERTO no ato, nunca
-- sobre o tag inteiro). O % sobre o tag EMPILHAVA em baixas parciais (re-prova
-- adversarial final: 9 baixas de 0,01 a 10 % + 9,91 quitaram 100 com 10,00
-- recebidos). O valor concedido é FATO do ato: gravado na própria baixa
-- (append-only); saldo em aberto = tag − Σ(pago − juros − multa + discount_value).
ALTER TABLE `tb_financial_payment`
  ADD COLUMN IF NOT EXISTS `discount_value` DECIMAL(10,2) NOT NULL DEFAULT 0.00
    COMMENT 'Desconto concedido NESTA baixa (R$) = saldo em aberto no ato x discount_aliquot (D-G28)'
    AFTER `discount_aliquot`;

-- Backfill: as baixas anteriores foram calculadas sobre o tag (semântica vigente
-- até aqui) — preserva o efeito que já tiveram nos saldos. Idempotente.
-- L3 (socrático da Rodada 6): a marca "valor 0 com alíquota > 0" deixou de ser
-- exclusiva do pré-050 — a porta manual grava legitimamente alíquota > 0 com valor
-- 0,00 (% que arredonda a zero em saldo pequeno). Em REPLAY (dump restaurado, linha
-- de `_migrations` perdida) o UPDATE inventaria desconto `tag × aliq`. O JOIN com a
-- derived table zera o backfill assim que existir QUALQUER linha com valor > 0 —
-- sinal de que ele já rodou ou de que já há baixas na semântica nova.
UPDATE `tb_financial_payment` p
 INNER JOIN `tb_financial` f
    ON f.tb_institution_id = p.tb_institution_id AND f.tb_order_id = p.tb_order_id
   AND f.terminal = p.terminal AND f.parcel = p.parcel
 INNER JOIN (SELECT COUNT(*) AS granted FROM `tb_financial_payment`
              WHERE `discount_value` > 0) g ON g.granted = 0
   SET p.discount_value = ROUND(f.tag_value * COALESCE(p.discount_aliquot, 0) / 100, 2)
 WHERE p.discount_value = 0 AND COALESCE(p.discount_aliquot, 0) > 0;
