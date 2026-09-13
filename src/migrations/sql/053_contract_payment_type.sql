-- 053 — A FORMA DE PAGAMENTO é do contrato (D14, Valdo 2026-09-13).
--
-- Fecha o par com a D13: o contrato de mensalidade já dizia QUANDO o cliente
-- paga (`payment_day`); agora diz também COMO. Antes, o lote impunha uma forma
-- única para todas as ordens selecionadas — bastava um cliente pagar por outro
-- meio para o lote deixar de servir.
--
-- NULL = não combinada: o operador informa a forma no faturamento, como hoje.
-- A PRESENÇA da forma é que decide (mesma regra do contrato financeiro/regra de
-- recebimento e da negociação do pedido) — nunca uma coluna "usa_contrato".
--
-- Sem FK: tb_payment_types vive em setes_central e o vínculo habilitado é
-- tb_institution_has_payment_types (PK institution+forma) — a validação de
-- "forma habilitada" é da peça `assertPaymentRules`, que já roda nas três
-- portas do faturamento; FK aqui só duplicaria a regra em outro lugar.
ALTER TABLE `tb_contract`
  ADD COLUMN IF NOT EXISTS `tb_payment_types_id` INT DEFAULT NULL
    COMMENT 'Forma combinada no contrato (D14); NULL = informar no faturamento'
    AFTER `payment_day`;
