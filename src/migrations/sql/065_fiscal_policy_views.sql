-- 065 — VIEWs de POLÍTICA do ERP publicadas para as APIs fiscais (extração fiscal, F0 —
-- Infra-IA/prompts/prompt_apis_fiscais_isoladas.md §14).
--
-- D-F32 (Valdo, 2026-10-04): o que as APIs fiscais (nfse-api/nfe-api) precisam saber de POLÍTICA do
-- ERP é publicado AQUI, como VIEW no schema do cliente, e o próprio setes-api passa a ler delas —
-- uma verdade só (nunca uma cópia da regra na API fiscal). A API fiscal só LÊ estas views (D-F31:
-- ela não escreve dado no ERP; só trava a linha da nota).
--
-- Regra de desempenho: nada de subconsulta na LISTA do SELECT, GROUP BY, DISTINCT ou LIMIT — o
-- MariaDB não funde view assim (vira tabela temporária com o schema inteiro a cada leitura). A
-- condição "último evento" vai no ON, por NOT EXISTS (molde do TX_SELECT da Onda 3), e o WHERE de
-- quem lê (instituição + nota) desce até as tabelas.

-- ---------------------------------------------------------------------------
-- 1. Interface do RAMO por pedido — espelho de `resolveOrderInterface`
--    (modules/billing/billing.interface-resolver.ts, Q-G22/Q-G29/D-A31): pedido com
--    ciclo de OS → 'service-orders'; com âncora de devolução (MESMO soft-deletada —
--    D-A31: a âncora morta ainda decide o ramo) → 'order-returns'; senão 'orders'.
--    Pedido que não está em tb_order não tem linha: quem lê aplica o default 'orders'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW `vw_order_interface` AS
SELECT o.`tb_institution_id`,
       o.`id`       AS `tb_order_id`,
       o.`terminal`,
       CASE
         WHEN so.`id` IS NOT NULL THEN 'service-orders'
         WHEN ra.`id` IS NOT NULL THEN 'order-returns'
         ELSE 'orders'
       END AS `interface_key`
  FROM `tb_order` o
  LEFT JOIN `tb_service_order` so
    ON so.`id` = o.`id` AND so.`tb_institution_id` = o.`tb_institution_id`
   AND so.`terminal` = o.`terminal` AND so.`deleted` = 'N'
  LEFT JOIN `tb_order_stock_adjust_return` ra
    ON ra.`id` = o.`id` AND ra.`tb_institution_id` = o.`tb_institution_id`
   AND ra.`terminal` = o.`terminal`;

-- ---------------------------------------------------------------------------
-- 2. VIDA vigente da nota (D-N27) — o evento E mais recente (a vida aberta pelo
--    último faturamento) e o ÚLTIMO evento da nota (E emitida / C cancelada).
--    A nota pendente cancelada é soft-deletada (D3) e o cabeçalho continua aqui
--    com `invoice_deleted` = 'S' — os eventos ficam (HIGH-3b da Onda 3).
--    Nota sem nenhum evento (sincronizada da origem) → life_event/last_kind NULL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW `vw_invoice_life` AS
SELECT i.`tb_institution_id`,
       i.`id`        AS `tb_invoice_id`,
       i.`terminal`,
       i.`deleted`   AS `invoice_deleted`,
       le.`event`    AS `life_event`,
       lv.`event`    AS `last_event`,
       lv.`kind`     AS `last_kind`
  FROM `tb_invoice` i
  LEFT JOIN `tb_invoice_event` le
    ON le.`tb_institution_id` = i.`tb_institution_id` AND le.`tb_invoice_id` = i.`id`
   AND le.`terminal` = i.`terminal` AND le.`kind` = 'E' AND le.`deleted` = 'N'
   AND NOT EXISTS (SELECT 1 FROM `tb_invoice_event` x
                    WHERE x.`tb_institution_id` = le.`tb_institution_id` AND x.`tb_invoice_id` = le.`tb_invoice_id`
                      AND x.`terminal` = le.`terminal` AND x.`kind` = 'E' AND x.`deleted` = 'N'
                      AND x.`event` > le.`event`)
  LEFT JOIN `tb_invoice_event` lv
    ON lv.`tb_institution_id` = i.`tb_institution_id` AND lv.`tb_invoice_id` = i.`id`
   AND lv.`terminal` = i.`terminal` AND lv.`deleted` = 'N'
   AND NOT EXISTS (SELECT 1 FROM `tb_invoice_event` y
                    WHERE y.`tb_institution_id` = lv.`tb_institution_id` AND y.`tb_invoice_id` = lv.`tb_invoice_id`
                      AND y.`terminal` = lv.`terminal` AND y.`deleted` = 'N'
                      AND y.`event` > lv.`event`);
