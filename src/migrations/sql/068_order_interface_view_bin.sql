-- 068 — F2a, etapa A2 (Infra-IA/prompts/prompt_apis_fiscais_isoladas.md §22.7/§22.9): `vw_order_interface.interface_key`
-- com COLAÇÃO FIXA (PADROES_BANCO §11 regra 3).
--
-- Achado da A1 da F2a (2026-10-12), reproduzido na view viva: `interface_key` vem de LITERAIS (CASE) e saía COERCÍVEL na
-- colação da conexão que CRIOU a view (utf8mb4_unicode_ci — o padrão do mysql2 3.x); numa conexão utf8mb4_general_ci,
-- `interface_key = 'orders'` dá o erro 1267 "Illegal mix of collations" — só no leitor do OUTRO serviço (a nfse-api compara
-- a coluna no SQL: `COALESCE(oi.interface_key, 'orders') IN (?)`). COLLATE explícito vence o literal de qualquer colação;
-- binário como o `authority_recorded` da 004 da nfse-api (domínio fechado: 'service-orders' · 'order-returns' · 'orders').
--
-- Só a coluna derivada muda: mesma lista de colunas, mesmos JOINs (segue FUNDÍVEL — expressão na lista do SELECT não impede
-- a fusão). A `vw_invoice_life` NÃO muda (as colunas vêm de tabela, com a colação da tabela). Rodar com o usuário dono de
-- sempre (o DEFINER da view é quem a recria; o GRANT de SELECT do usuário da API fiscal sobrevive ao REPLACE). Re-executável.
-- Espelho no canônico: `sql/03_*.sql` (bloco das VIEWs de política).
CREATE OR REPLACE VIEW `vw_order_interface` AS
SELECT o.`tb_institution_id`,
       o.`id`       AS `tb_order_id`,
       o.`terminal`,
       (CASE
          WHEN so.`id` IS NOT NULL THEN 'service-orders'
          WHEN ra.`id` IS NOT NULL THEN 'order-returns'
          ELSE 'orders'
        END) COLLATE utf8mb4_bin AS `interface_key`
  FROM `tb_order` o
  LEFT JOIN `tb_service_order` so
    ON so.`id` = o.`id` AND so.`tb_institution_id` = o.`tb_institution_id`
   AND so.`terminal` = o.`terminal` AND so.`deleted` = 'N'
  LEFT JOIN `tb_order_stock_adjust_return` ra
    ON ra.`id` = o.`id` AND ra.`tb_institution_id` = o.`tb_institution_id`
   AND ra.`terminal` = o.`terminal`;
