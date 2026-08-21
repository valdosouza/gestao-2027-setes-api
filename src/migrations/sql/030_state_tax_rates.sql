-- 030 — Catálogo MVA/FCP por UF×NCM (fase Faturamento Fiscal e Financeiro,
-- W2 Onda 2 — Rodada 3 do prompt_fase_faturamento_financeiro.md).
--
-- Bloqueio real encontrado ao desenhar a orquestração do faturamento: o
-- motor de cálculo (@shared/tax-rule/calc.ts) já espera `stAliq`/`mvaPct`
-- resolvidos (P2.7/P3.1), mas não existe tabela nenhuma pra fornecê-los —
-- o legado tinha TB_MVA_UF_NCM/TB_FCP_UF_NCM; a decisão Q22 já tinha fixado
-- o desenho (schema do cliente, sem compartilhamento entre institutions —
-- MVA é interpretação, não dado de fato) mas a tabela nunca foi criada.
--
-- Chave UF × NCM × institution: a MESMA tabela de MVA serve o ICMS-ST
-- (alíquota/MVA pela UF do DESTINATÁRIO) e a alíquota NR do Simples
-- (mesma tabela, pela UF do EMITENTE) — quem escolhe o stateId é o CALLER
-- do motor (a orquestração da próxima onda), não a tabela.
--
-- Match do NCM: MVA por IGUALDADE EXATA (decisão 36, mesma fidelidade do
-- motor da regra); FCP por PREFIXO (P7.1 — "a primeira linha que casar
-- vence", capítulo/posição podem ser parciais) — resolvido no repository do
-- módulo `state-tax-rates`, não aqui.
--
-- Sem tela no app ainda (Q22 — fica para a onda do app desta fase); sem
-- endpoint de sync (dado do cliente, mantido só pela tela/API nova).

CREATE TABLE IF NOT EXISTS `tb_state_mva_ncm` (
  `id`                 int(11) NOT NULL,
  `tb_institution_id`  int(11) NOT NULL,
  `tb_state_id`        int(11) NOT NULL,
  `ncm`                varchar(8) NOT NULL,
  `internal_aliq`      decimal(10,2) NOT NULL DEFAULT 0,
  `mva_original`       decimal(10,4) NOT NULL DEFAULT 0,
  `mva_adjusted`       decimal(10,4) DEFAULT NULL,
  `created_at`         datetime DEFAULT NULL,
  `updated_at`         datetime DEFAULT NULL,
  `deleted`            char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_state_mva_ncm` (`tb_institution_id`,`tb_state_id`,`ncm`),
  CONSTRAINT `fk_state_mva_ncm_state` FOREIGN KEY (`tb_state_id`) REFERENCES `setes_central`.`tb_state` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tb_state_fcp_ncm` (
  `id`                 int(11) NOT NULL,
  `tb_institution_id`  int(11) NOT NULL,
  `tb_state_id`        int(11) NOT NULL,
  `ncm`                varchar(8) NOT NULL,
  `aliq`               decimal(10,2) NOT NULL DEFAULT 0,
  `created_at`         datetime DEFAULT NULL,
  `updated_at`         datetime DEFAULT NULL,
  `deleted`            char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_state_fcp_ncm` (`tb_institution_id`,`tb_state_id`,`ncm`),
  CONSTRAINT `fk_state_fcp_ncm_state` FOREIGN KEY (`tb_state_id`) REFERENCES `setes_central`.`tb_state` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
