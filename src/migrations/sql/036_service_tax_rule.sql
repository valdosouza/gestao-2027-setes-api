-- 036 — Regra de Tributação de SERVIÇO (ISS) + especialização tb_service
-- (prompt_regra_tributacao_servico.md — rodadas 1–2 fechadas 2026-09-02:
-- D1 FK literal serviço→regra; D3 tb_service espelho da tb_merchandise;
-- D4 código municipal na regra; D12 cidade de INCIDÊNCIA na regra (billing
-- confere contra a cidade do tomador); D13 alíquota na regra).
-- Onda 2. Sem dados a migrar (tabelas novas). Canônico: sql/03.

-- Regra de tributação de SERVIÇO (ISS) — prompt_regra_tributacao_servico.md
-- (D1/D4/D12/D13, 2026-09-02): o que o MUNICÍPIO cobra de um item da Lista
-- de Serviços (LC 116): cidade de incidência × item → alíquota + código
-- municipal. Dado fiscal INTERPRETÁVEL do cliente (schema do cliente, como
-- MVA/FCP — nunca compartilhado na central, D8). tb_service_list_id SEM FK
-- física (catálogo central varchar — validado na peça, padrão dos CSTs da
-- 025); tb_city_id com FK à central. tb_taxes_id = elo da reforma (IBS),
-- sem FK (mesmo status da tb_tax_rule). Unicidade do FATO (institution ×
-- cidade × item) garantida pela aplicação (409) — soft delete impede UNIQUE.
CREATE TABLE IF NOT EXISTS `tb_service_tax_rule` (
  `id`                  int(11) NOT NULL,
  `tb_institution_id`   int(11) NOT NULL,
  `tb_city_id`          int(11) NOT NULL,
  `tb_service_list_id`  varchar(10) NOT NULL,
  `aliq`                decimal(10,2) NOT NULL DEFAULT 0.00,
  `municipal_code`      varchar(20) DEFAULT NULL,
  `active`              char(1) NOT NULL DEFAULT 'S',
  `tb_taxes_id`         int(11) DEFAULT NULL,
  `created_at`          datetime DEFAULT NULL,
  `updated_at`          datetime DEFAULT NULL,
  `deleted`             char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  KEY `idx_service_tax_rule_fact` (`tb_institution_id`, `tb_city_id`, `tb_service_list_id`),
  CONSTRAINT `fk_service_tax_rule_institution` FOREIGN KEY (`tb_institution_id`) REFERENCES `setes_central`.`tb_institution` (`id`),
  CONSTRAINT `fk_service_tax_rule_city` FOREIGN KEY (`tb_city_id`) REFERENCES `setes_central`.`tb_city` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Especialização FISCAL do serviço (D3 — espelho da tb_merchandise, herança
-- por PK compartilhada com tb_product kind='S'): o serviço aponta a REGRA
-- (D1, FK literal). Natureza do produto continua sendo tb_product.kind.
CREATE TABLE IF NOT EXISTS `tb_service` (
  `id`                      int(11) NOT NULL,
  `tb_institution_id`       int(11) NOT NULL,
  `tb_service_tax_rule_id`  int(11) DEFAULT NULL,
  `created_at`              datetime DEFAULT NULL,
  `updated_at`              datetime DEFAULT NULL,
  `deleted`                 char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`, `tb_institution_id`),
  KEY `idx_service_tax_rule` (`tb_service_tax_rule_id`, `tb_institution_id`),
  CONSTRAINT `fk_service_product` FOREIGN KEY (`id`, `tb_institution_id`) REFERENCES `tb_product` (`id`, `tb_institution_id`),
  CONSTRAINT `fk_service_tax_rule` FOREIGN KEY (`tb_service_tax_rule_id`, `tb_institution_id`) REFERENCES `tb_service_tax_rule` (`id`, `tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
