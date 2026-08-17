-- 025 — Família da Regra de Tributação (fase Faturamento Fiscal e Financeiro)
-- Decisões 1/23 (seletor + peças 1:1, presença = incidência) e 30 (aposenta
-- tb_tax_ruler) do prompt_fase_faturamento_financeiro.md; parecer setes-conceito
-- 2026-08-16 (catálogo CST em setes_central × regra no schema do cliente).
--
-- SELETOR (tb_tax_rule): somente os campos do WHERE do motor legado
-- (tributacao.md §2). Coringas por NULL: tb_product_id NULL = qualquer produto,
-- tb_entity_id NULL = qualquer destinatário, tb_state_id NULL = coringa
-- interestadual, ncm NULL = sem exigência (regra COM ncm vence — precedência).
-- As 6 sutilezas do matching vivem na peça @shared/tax-rule, NUNCA em endpoint.
--
-- PRESENÇA = "a regra DEFINE o tributo": CST de isenção (ICMS 40/41, PIS/COFINS
-- 07/08) é peça PRESENTE com alíquota nula — o XML exige o grupo com CST.
--
-- D30 — checagem ANTES de aplicar em schema com dados (esperado 0; não há
-- produtor da tabela larga — verificado: nenhum endpoint do sync a alimenta):
--   SELECT COUNT(*) FROM tb_tax_ruler;

CREATE TABLE IF NOT EXISTS `tb_tax_rule` (
  `id`                 int(11) NOT NULL,
  `tb_institution_id`  int(11) NOT NULL,
  `tb_product_id`      int(11) DEFAULT NULL,
  `tb_entity_id`       int(11) DEFAULT NULL,
  `ncm`                varchar(8) DEFAULT NULL,
  `origin`             char(1) NOT NULL,
  `final_consumer`     char(1) NOT NULL DEFAULT 'N',
  `simples`            char(1) NOT NULL DEFAULT 'N',
  `st`                 char(1) NOT NULL DEFAULT 'N',
  `purpose`            char(1) NOT NULL DEFAULT '0',
  `direction`          char(1) DEFAULT NULL,
  `tb_cfop_id`         varchar(10) DEFAULT NULL,
  `tb_state_id`        int(11) DEFAULT NULL,
  `tb_observation_id`  int(11) DEFAULT NULL,
  `tb_taxes_id`        int(11) DEFAULT NULL,
  `created_at`         datetime DEFAULT NULL,
  `updated_at`         datetime DEFAULT NULL,
  `deleted`            char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `idx_tax_rule_selector` (`tb_institution_id`,`origin`,`st`,`final_consumer`,`simples`,`purpose`),
  KEY `idx_tax_rule_ncm` (`ncm`),
  KEY `idx_tax_rule_cfop` (`tb_cfop_id`),
  CONSTRAINT `fk_tax_rule_entity` FOREIGN KEY (`tb_entity_id`) REFERENCES `setes_central`.`tb_entity` (`id`),
  CONSTRAINT `fk_tax_rule_state` FOREIGN KEY (`tb_state_id`) REFERENCES `setes_central`.`tb_state` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- FKs cross-schema só em colunas INT (entity/state). Colunas STRING que
-- referenciam catálogos centrais (tb_cfop_id aqui; CSTs/modBC nas peças) ficam
-- SEM FK física: os catálogos centrais foram criados sem COLLATE explícito e o
-- mismatch de collation derruba FK de string cross-schema (caso real do
-- PADROES_BANCO §5). Integridade validada pela peça @shared/tax-rule; FK física
-- pode voltar após auditoria/normalização de collation dos catálogos.

-- direction: filtro de CADASTRO (lista CFOPs de entrada ou saída no lookup —
-- Q14 do tributacao.md); quem participa do match é o sentido da natureza.
-- purpose: finalidade 0-7 ('0' = Outras — ajustes, decisão do motor legado).
-- tb_taxes_id: elo da reforma IBS/CBS (Q15) — SEM FK: tb_taxes ainda não
-- existe na web; criar a FK quando a tabela nascer.
-- tb_observation_id: catálogo local de observação fiscal (tb_observation).

-- Peça ICMS próprio (inclui diferimento e destaque — decisão 23b)
CREATE TABLE IF NOT EXISTS `tb_tax_rule_icms` (
  `id`                          int(11) NOT NULL,
  `tb_tax_icms_nr_id`           char(2) DEFAULT NULL,
  `tb_tax_icms_sn_id`           char(3) DEFAULT NULL,
  `tb_deter_base_tax_icms_id`   char(2) DEFAULT NULL,
  `tb_discharge_icms_id`        int(11) DEFAULT NULL,
  `aliq`                        decimal(10,2) DEFAULT NULL,
  `aliq_reduction`              decimal(10,2) DEFAULT NULL,
  `base_reduction`              decimal(10,2) DEFAULT NULL,
  `deferred`                    char(1) NOT NULL DEFAULT 'N',
  `deferred_aliq`               decimal(10,2) DEFAULT NULL,
  `highlight`                   char(1) NOT NULL DEFAULT 'N',
  `created_at`                  datetime DEFAULT NULL,
  `updated_at`                  datetime DEFAULT NULL,
  `deleted`                     char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_txr_icms_rule` FOREIGN KEY (`id`) REFERENCES `tb_tax_rule` (`id`),
  CONSTRAINT `fk_txr_icms_discharge` FOREIGN KEY (`tb_discharge_icms_id`) REFERENCES `setes_central`.`tb_discharge_icms` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- CST (nr) × CSOSN (sn): ambos anuláveis — qual vale é decidido pelo CRT do
-- EMITENTE no momento do cálculo (P2.3), nunca pelos dois ao mesmo tempo.
-- CSTs/modBC (colunas string): sem FK física — ver nota de collation acima;
-- validação na peça @shared/tax-rule contra os catálogos centrais.

-- Peça ICMS-ST (alíquota/MVA vêm de TB_MVA_UF_NCM — decisão 9; aqui só
-- modalidade da base e a propagação da redução)
CREATE TABLE IF NOT EXISTS `tb_tax_rule_icms_st` (
  `id`                             int(11) NOT NULL,
  `tb_deter_base_tax_icms_st_id`   char(2) DEFAULT NULL,
  `propagate_base_reduction`       char(1) NOT NULL DEFAULT 'N',
  `created_at`                     datetime DEFAULT NULL,
  `updated_at`                     datetime DEFAULT NULL,
  `deleted`                        char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_txr_st_rule` FOREIGN KEY (`id`) REFERENCES `tb_tax_rule` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Peça IPI
CREATE TABLE IF NOT EXISTS `tb_tax_rule_ipi` (
  `id`              int(11) NOT NULL,
  `tb_tax_ipi_id`   char(2) NOT NULL,
  `aliq`            decimal(10,2) DEFAULT NULL,
  `created_at`      datetime DEFAULT NULL,
  `updated_at`      datetime DEFAULT NULL,
  `deleted`         char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_txr_ipi_rule` FOREIGN KEY (`id`) REFERENCES `tb_tax_rule` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Peça PIS/COFINS — UMA forma, kind 'P'|'C' (decisão 2: "PIS = COFINS" por
-- construção; padrão lista-por-tipo, PK composta id+kind).
-- cst SEM FK física: os catálogos (tb_tax_pis × tb_tax_cofins) são distintos
-- por kind — validação na aplicação (peça @shared/tax-rule).
CREATE TABLE IF NOT EXISTS `tb_tax_rule_pis_cofins` (
  `id`          int(11) NOT NULL,
  `kind`        char(1) NOT NULL,
  `cst`         char(2) NOT NULL,
  `aliq`        decimal(10,2) DEFAULT NULL,
  `created_at`  datetime DEFAULT NULL,
  `updated_at`  datetime DEFAULT NULL,
  `deleted`     char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`kind`),
  CONSTRAINT `fk_txr_piscofins_rule` FOREIGN KEY (`id`) REFERENCES `tb_tax_rule` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Peça II — bloco de importação COMPLETO (decisões 11 e Q32: código vivo)
CREATE TABLE IF NOT EXISTS `tb_tax_rule_ii` (
  `id`             int(11) NOT NULL,
  `ii_aliq`        decimal(10,2) DEFAULT NULL,
  `irpj_aliq`      decimal(10,2) DEFAULT NULL,
  `csll_aliq`      decimal(10,2) DEFAULT NULL,
  `afrmm_aliq`     decimal(10,5) DEFAULT NULL,
  `siscomex_aliq`  decimal(10,5) DEFAULT NULL,
  `created_at`     datetime DEFAULT NULL,
  `updated_at`     datetime DEFAULT NULL,
  `deleted`        char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_txr_ii_rule` FOREIGN KEY (`id`) REFERENCES `tb_tax_rule` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Decisão 30: aposenta a tabela larga do baseline (sem produtor; regra nasce
-- decomposta — sem migração de linhas).
DROP TABLE IF EXISTS `tb_tax_ruler`;
