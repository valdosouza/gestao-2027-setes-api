-- 035 — Comissão por item + Devolução de mercadoria (fase Faturamento
-- Fiscal e Financeiro — rodada Q1–Q5 do Valdo em 2026-08-24 + parecer
-- setes-conceito da mesma data; origem R5-Q1 do billing).
--
-- Três peças novas (schema do cliente) + um DROP autorizado:
--
-- 1. tb_commission — lançamento IMUTÁVEL do direito do vendedor por ITEM
--    faturado (nesta versão o cálculo é por item — decisão Q1; o legado
--    TB_COMISSAO era por pedido). Devolução NUNCA apaga/edita: entra
--    lançamento com value NEGATIVO (Q2 — filosofia do financeiro imutável).
--    kind: 'F' = comissão pelo faturamento | 'R' = pelo recebimento
--    (Q5 — modo por config; nesta versão mínima só 'F' tem produtor; o
--    'R' futuro AGREGA coluna nullable de parcela, não reforma a peça).
--
-- 2. tb_order_item_return — elo item de devolução → item vendido original
--    (equivalente web da TB_ITENS_DEV do legado — Q3). PK = a própria PK
--    do item de devolução (padrão detalhe universal + especialização, como
--    tb_order_item_merchandise); SEM colunas de quantidade/valor: o saldo
--    devolvível é DERIVADO (quantity dos itens ligados à mesma origem) —
--    elo e item não podem divergir por construção.
--
-- 3. tb_order_stock_adjust_return — âncora do ajuste Entrada no pedido de
--    venda original (presença da linha = "é devolução contra pedido").
--    SEM coluna de vendedor: o vendedor é DERIVADO do tb_order_sale da
--    origem (decisão D3 do Valdo, 2026-08-24 — "do jeito que falei fica
--    ambíguo"; a regra do legado "vendedor informado = PED_CODVDO" morre
--    por construção: não existe segundo campo para divergir).
--
-- DROP tb_kickback (autorizado pelo Valdo em 2026-08-24): tabela dormente
-- do baseline com o MESMO conceito e nome errado (kickback = propina) —
-- a fundação renasce como tb_commission; zero produtores/consumidores
-- conferidos no código antes do drop.

DROP TABLE IF EXISTS `tb_kickback`;

CREATE TABLE IF NOT EXISTS `tb_commission` (
  `id`                 int(11) NOT NULL,
  `tb_institution_id`  int(11) NOT NULL,
  `terminal`           int(11) NOT NULL DEFAULT 0,
  `kind`               char(1) NOT NULL DEFAULT 'F',
  `tb_order_id`        int(11) NOT NULL,
  `tb_order_item_id`   int(11) NOT NULL,
  `tb_order_item_kind` varchar(50) NOT NULL DEFAULT 'Sale',
  `tb_customer_id`     int(11) NOT NULL,
  `tb_salesman_id`     int(11) NOT NULL,
  `base_value`         decimal(10,2) NOT NULL,
  `aliq`               decimal(10,2) NOT NULL,
  `value`              decimal(10,2) NOT NULL,
  `dt_payment`         date DEFAULT NULL,
  `created_at`         datetime DEFAULT NULL,
  `updated_at`         datetime DEFAULT NULL,
  `deleted`            char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`),
  KEY `idx_commission_item` (`tb_institution_id`,`tb_order_id`,`tb_order_item_id`),
  KEY `idx_commission_salesman` (`tb_institution_id`,`tb_salesman_id`),
  CONSTRAINT `fk_commission_order` FOREIGN KEY (`tb_order_id`,`tb_institution_id`,`terminal`)
    REFERENCES `tb_order` (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- kind: 'F'aturamento | 'R'ecebimento (domínio Q5). value NEGATIVO =
-- estorno por devolução. tb_order_item_kind completa a coordenada do item
-- (PK do tb_order_item inclui kind — referência parcial seria ambígua).
-- FKs de customer/salesman não são físicas: papéis alimentados também pelo
-- sincronizador (mesma escolha da família tb_order_item_tax_rule).

CREATE TABLE IF NOT EXISTS `tb_order_item_return` (
  `id`                   int(11) NOT NULL,
  `tb_institution_id`    int(11) NOT NULL,
  `tb_order_id`          int(11) NOT NULL,
  `terminal`             int(11) NOT NULL DEFAULT 0,
  `kind`                 varchar(50) NOT NULL DEFAULT 'Adjust',
  `tb_order_id_ori`      int(11) NOT NULL,
  `tb_order_item_id_ori` int(11) NOT NULL,
  `terminal_ori`         int(11) NOT NULL DEFAULT 0,
  `kind_ori`             varchar(50) NOT NULL DEFAULT 'Sale',
  `created_at`           datetime DEFAULT NULL,
  `updated_at`           datetime DEFAULT NULL,
  `deleted`              char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`terminal`,`kind`),
  KEY `idx_item_return_ori` (`tb_institution_id`,`tb_order_id_ori`,`tb_order_item_id_ori`),
  CONSTRAINT `fk_item_return_item` FOREIGN KEY
    (`id`,`tb_institution_id`,`tb_order_id`,`terminal`,`kind`)
    REFERENCES `tb_order_item` (`id`,`tb_institution_id`,`tb_order_id`,`terminal`,`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
-- COLLATE general_ci (≠ 031): a FK composta inclui `kind` varchar e a
-- colação PRECISA casar com a do tb_order_item do baseline (general_ci) —
-- divergência = errno 150 (regra registrada no PADROES_BANCO.md §5).
-- Sufixo _ori segue precedente do sistema (tb_order_stock_transfer
-- tb_stock_list_id_ori/_des). FK da ORIGEM não é física: o item vendido
-- pode vir do sincronizador e seu soft delete não deve ser bloqueado por
-- resíduo de devolução — a existência é validada no faturamento.

CREATE TABLE IF NOT EXISTS `tb_order_stock_adjust_return` (
  `id`                int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal`          int(11) NOT NULL DEFAULT 0,
  `tb_order_id_ori`   int(11) NOT NULL,
  `terminal_ori`      int(11) NOT NULL DEFAULT 0,
  `created_at`        datetime DEFAULT NULL,
  `updated_at`        datetime DEFAULT NULL,
  `deleted`           char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`),
  KEY `idx_adjust_return_ori` (`tb_institution_id`,`tb_order_id_ori`),
  CONSTRAINT `fk_adjust_return_adjust` FOREIGN KEY (`id`,`tb_institution_id`,`terminal`)
    REFERENCES `tb_order_stock_adjust` (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- FK da origem (tb_order_id_ori) não é física — mesma razão acima.
