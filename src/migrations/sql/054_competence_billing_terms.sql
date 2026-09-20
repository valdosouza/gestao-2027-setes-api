-- 054 — As CONDIÇÕES de cobrança ficam CONGELADAS no fato da competência
-- (D23 = Q-R1 da fase Primeiro Cliente, Valdo 2026-09-19: "siga as recomendações").
--
-- O fato gravado pela rotina mensal (051) era "o contrato C faturou o produto P na
-- competência Y gerando o item I da OS". O lote, porém, resolvia dia e forma de
-- cobrança pelo contrato VIVO no momento do faturamento: editar ou excluir o
-- contrato mudava a cobrança de um mês que ele já tinha gerado — atrito direto com
-- o princípio da D-A36 ("nada é reescrito no passado"; o saldo é derivado do
-- vigente, mas o fato de cada ato é imutável).
--
-- Agora o fato carrega as condições que o contrato tinha NO ATO da injeção:
-- `payment_day` (QUANDO) e `tb_payment_types_id` (COMO). O lote lê daqui; o
-- contrato editado só governa meses FUTUROS. NULL na forma continua significando
-- "informar no faturamento" (mesma semântica da 053). A OS cancelada devolve a
-- competência e a reinjeção é um ato NOVO — grava as condições de então.
--
-- Sem FK para tb_payment_types (vive em setes_central) — mesma razão da 053.
ALTER TABLE `tb_contract_item_competence`
  ADD COLUMN IF NOT EXISTS `payment_day` INT DEFAULT NULL
    COMMENT 'Dia de vencimento que o contrato tinha NO ATO da injeção (D23)'
    AFTER `tb_order_item_id`,
  ADD COLUMN IF NOT EXISTS `tb_payment_types_id` INT DEFAULT NULL
    COMMENT 'Forma combinada NO ATO da injeção (D23); NULL = informar no faturamento'
    AFTER `payment_day`;

-- Backfill: competências já injetadas herdam as condições do contrato de HOJE — é a
-- melhor fonte disponível (até aqui era exatamente ela que valia). Idempotente:
-- `payment_day` é NOT NULL no contrato, então linha com dia preenchido já passou
-- por aqui (ou nasceu pela rotina nova) e não é tocada — inclusive em replay.
UPDATE `tb_contract_item_competence` comp
 INNER JOIN `tb_contract` c
    ON c.id = comp.tb_contract_id AND c.tb_institution_id = comp.tb_institution_id
   SET comp.payment_day = c.payment_day,
       comp.tb_payment_types_id = c.tb_payment_types_id,
       comp.updated_at = NOW()
 WHERE comp.payment_day IS NULL;
