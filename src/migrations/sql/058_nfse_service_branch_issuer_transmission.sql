-- 058 — Onda 3 (NFS-e pelo Padrão Nacional) + peças comuns da NF-e (D-E20 a):
-- ramo de serviço COMPLETO, fatos do emitente, código nacional na regra de ISS,
-- habilitação do emissor por MODELO, transmissão do DPS e voz do fisco.
-- Decisões: D-N1…D-N16 (prompts/prompt_onda3_nfse_adn.md §8) e D-E1…D-E25
-- (prompts/prompt_onda_nfe_sefaz.md §8/§10). Guardião: conceitos A–E do §3.
-- MariaDB 10.4: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS (idempotente).

-- ---------------------------------------------------------------------------
-- 1. Fatos do EMITENTE (D-E3/D-E23): consumidos pelos dois documentos fiscais.
--    Vivem em tb_entity_tax da institution (PK id = institution), não na
--    habilitação — regime é da empresa, não do modelo do documento.
-- ---------------------------------------------------------------------------
ALTER TABLE `tb_entity_tax`
  ADD COLUMN IF NOT EXISTS `simples_regime` CHAR(1) DEFAULT NULL
    COMMENT 'opSimpNac da DPS: 1 não optante · 2 MEI · 3 ME/EPP (Simples). NULL = não informado'
    AFTER `tax_regime`,
  ADD COLUMN IF NOT EXISTS `special_tax_regime` CHAR(1) DEFAULT NULL
    COMMENT 'regEspTrib da DPS: 0 nenhum · 1 ato cooperado · 2 estimativa · 3 microempresa municipal · 4 notário/registrador · 5 profissional autônomo · 6 sociedade de profissionais (CRET do legado)'
    AFTER `simples_regime`,
  ADD COLUMN IF NOT EXISTS `cnae` VARCHAR(7) DEFAULT NULL
    COMMENT 'CNAE principal (7 dígitos) — fato do emitente'
    AFTER `special_tax_regime`;

-- ---------------------------------------------------------------------------
-- 2. Código de tributação NACIONAL na regra de ISS (D-N11/D-N11a). O catálogo
--    é central (tb_service_national_code, seed sql/57); NULL = derivar quando o
--    subitem tem UM único desdobro (o resolver faz isso), obrigatório informar
--    quando há vários. FK cross-schema explícita (PADROES §5).
-- ---------------------------------------------------------------------------
ALTER TABLE `tb_service_tax_rule`
  ADD COLUMN IF NOT EXISTS `national_code` CHAR(6) DEFAULT NULL
    COMMENT 'cTribNac (setes_central.tb_service_national_code.code); NULL = único desdobro do subitem, derivado'
    AFTER `municipal_code`;
ALTER TABLE `tb_service_tax_rule`
  ADD CONSTRAINT `fk_service_tax_rule_national_code` FOREIGN KEY (`national_code`)
    REFERENCES `setes_central`.`tb_service_national_code` (`code`);

-- ---------------------------------------------------------------------------
-- 3. Ramo de SERVIÇO cresce por COLUNAS (A2 da Onda 0; um DPS = um serviço —
--    D-N2). Congelado no faturamento como o ramo de mercadoria congela base/ICMS.
--    Emitente/tomador NÃO se congelam aqui: o XML assinado é o snapshot.
-- ---------------------------------------------------------------------------
ALTER TABLE `tb_invoice_service`
  ADD COLUMN IF NOT EXISTS `tb_service_list_id` VARCHAR(10) DEFAULT NULL COMMENT 'Subitem LC 116 (congelado)' AFTER `total_value`,
  ADD COLUMN IF NOT EXISTS `national_code`      CHAR(6) DEFAULT NULL COMMENT 'cTribNac congelado (da regra ou derivado)' AFTER `tb_service_list_id`,
  ADD COLUMN IF NOT EXISTS `municipal_code`     VARCHAR(20) DEFAULT NULL COMMENT 'cTribMun congelado (da regra)' AFTER `national_code`,
  ADD COLUMN IF NOT EXISTS `tb_city_id`         INT(11) DEFAULT NULL COMMENT 'Cidade de INCIDÊNCIA (da regra) — cLocPrestacao' AFTER `municipal_code`,
  ADD COLUMN IF NOT EXISTS `base_iss_value`     DECIMAL(10,2) DEFAULT NULL COMMENT 'Σ base de tb_order_item_issqn' AFTER `tb_city_id`,
  ADD COLUMN IF NOT EXISTS `aliq_iss`           DECIMAL(10,2) DEFAULT NULL COMMENT 'Alíquota (%) da regra' AFTER `base_iss_value`,
  ADD COLUMN IF NOT EXISTS `iss_value`          DECIMAL(10,2) DEFAULT NULL COMMENT 'Σ ISS de tb_order_item_issqn' AFTER `aliq_iss`,
  ADD COLUMN IF NOT EXISTS `iss_withheld`       CHAR(1) NOT NULL DEFAULT 'N' COMMENT 'tpRetISSQN: S = retido pelo tomador (D-N8; fonte = tb_entity_tax.iss_retido do tomador)' AFTER `iss_value`,
  ADD COLUMN IF NOT EXISTS `liability`          CHAR(1) NOT NULL DEFAULT '1' COMMENT 'tribISSQN: 1 tributável · 2 imune · 3 exportação · 4 não incidência (D-N8)' AFTER `iss_withheld`,
  ADD COLUMN IF NOT EXISTS `dps_number`         INT(11) DEFAULT NULL COMMENT 'nDPS — write-once, cunhado na 1ª transmissão (D-N3); NULL = nunca transmitido' AFTER `liability`,
  ADD COLUMN IF NOT EXISTS `description`        TEXT DEFAULT NULL COMMENT 'xDescServ montado dos itens no faturamento (config dps_description_format)' AFTER `dps_number`;
ALTER TABLE `tb_invoice_service`
  ADD KEY IF NOT EXISTS `idx_invoice_service_dps` (`tb_institution_id`, `dps_number`);

-- ---------------------------------------------------------------------------
-- 4. tb_invoice_event: a reserva T A R D I é LIBERADA (D-N1, espelho da D-I5 da
--    Onda 2): a voz do fisco vive em tabela própria; a nota só tem E/C.
-- ---------------------------------------------------------------------------
ALTER TABLE `tb_invoice_event`
  MODIFY `kind` CHAR(1) NOT NULL
    COMMENT 'E emitida · C cancelada. A voz do fisco (enviado/autorizado/rejeitado/denegado) NÃO entra aqui: vive em tb_invoice_<ramo>_transmission_event (D-N1); nunca X';

-- ---------------------------------------------------------------------------
-- 5. Habilitação do EMISSOR (conceito A; D-E1/D-N4): UMA linha por MODELO do
--    documento (SE = NFS-e nacional · 55 = NF-e · 65 = NFC-e). Autoridade é
--    DERIVADA do modelo. Segredos (A1 em PEM) no cofre por AMBIENTE
--    (secret-store owner 'establishment', ownerId = institution) — nunca coluna.
--    Habilitado = presença da linha + certificado válido (D-E4, sem active).
--    Série = contador do emissor por modelo (D-E2: aposenta a config invoice_serie).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tb_establishment_issuer` (
  `tb_institution_id` INT(11) NOT NULL COMMENT 'O emissor É a institution (tb_institution.id = tb_entity.id = tb_company.id)',
  `model`             VARCHAR(2) NOT NULL COMMENT 'Modelo do documento (domínio de tb_invoice.model): SE · 55 · 65',
  `environment`       CHAR(1) NOT NULL DEFAULT 'H' COMMENT 'H produção restrita/homologação · P produção (o cofre é por ambiente)',
  `serie`             VARCHAR(5) NOT NULL DEFAULT '1' COMMENT 'Série do documento deste modelo (DPS: 00001–49999)',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `model`),
  CONSTRAINT `fk_establishment_issuer_institution` FOREIGN KEY (`tb_institution_id`)
    REFERENCES `setes_central`.`tb_institution` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- D-E2 (implantação): a config invoice_serie (interface billing, scope I) vira a
-- série da linha 55 — só onde a institution tinha valor próprio gravado.
INSERT INTO `tb_establishment_issuer`
  (`tb_institution_id`, `model`, `environment`, `serie`, `tb_user_id`, `created_at`, `updated_at`, `deleted`)
SELECT c.tb_institution_id, '55', 'H', LEFT(c.content, 5), NULL, NOW(), NOW(), 'N'
  FROM `tb_institution_has_config` c
  JOIN `setes_central`.`tb_interface` i ON i.id = c.tb_interface_id
 WHERE i.i18n_key = 'billing' AND c.name = 'invoice_serie' AND c.deleted = 'N'
   AND c.tb_user_id = 0 AND c.content IS NOT NULL AND c.content <> ''
ON DUPLICATE KEY UPDATE `serie` = VALUES(`serie`), `updated_at` = NOW();

-- ---------------------------------------------------------------------------
-- 6. Transmissão do DPS (conceito B): 1 ramo de serviço × N tentativas.
--    environment CONGELADO; dps_id/access_key/nfse_number/dh_proc WRITE-ONCE
--    (chegam na autorização/consulta, nunca mudam); last_queried_at = "nós olhamos
--    o fisco" (D-I20). XML autorizado em STORAGE_PATH/<cnpj>/<ano>/<mes>.
--    Reapresentar = attempt + 1, nunca UPDATE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tb_invoice_service_transmission` (
  `tb_institution_id` INT(11) NOT NULL,
  `tb_invoice_id`     INT(11) NOT NULL,
  `terminal`          INT(11) NOT NULL DEFAULT 0,
  `attempt`           INT(11) NOT NULL COMMENT 'Sequência 1..N por nota',
  `environment`       CHAR(1) NOT NULL COMMENT 'H/P congelado da habilitação no envio',
  `dps_id`            VARCHAR(45) DEFAULT NULL COMMENT 'infDPS/@Id (DPS + cMun + tpInsc + inscrição + série + nDPS) — nosso, nasce no envio',
  `access_key`        VARCHAR(50) DEFAULT NULL COMMENT 'Chave de acesso da NFS-e (50) — do fisco, write-once',
  `nfse_number`       VARCHAR(13) DEFAULT NULL COMMENT 'nNFSe — do fisco, write-once',
  `dh_proc`           DATETIME DEFAULT NULL COMMENT 'dhProc da autorização — write-once',
  `last_queried_at`   DATETIME DEFAULT NULL COMMENT 'Última consulta ao fisco (rodízio/throttle); NULL = nunca',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`),
  UNIQUE KEY `uk_invoice_service_transmission_dps` (`tb_institution_id`, `dps_id`),
  UNIQUE KEY `uk_invoice_service_transmission_key` (`tb_institution_id`, `access_key`),
  KEY `idx_invoice_service_transmission_query` (`tb_institution_id`, `last_queried_at`),
  CONSTRAINT `fk_invoice_service_transmission_invoice` FOREIGN KEY (`tb_invoice_id`, `tb_institution_id`, `terminal`)
    REFERENCES `tb_invoice` (`id`, `tb_institution_id`, `terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 7. Voz do FISCO (conceito C, append-only). kind = NOSSA leitura: S enviado ·
--    A autorizada · R rejeitada · C cancelada · K cancelamento em voo · F falha
--    explícita; authority_code = código cru (E0xxx); source P resposta direta /
--    Q consulta; invoice_event = causa → efeito (C local produzido — precedente
--    slip_event); idempotência por (kind, dh). Situação desconhecida → 502.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tb_invoice_service_transmission_event` (
  `tb_institution_id` INT(11) NOT NULL,
  `tb_invoice_id`     INT(11) NOT NULL,
  `terminal`          INT(11) NOT NULL DEFAULT 0,
  `attempt`           INT(11) NOT NULL,
  `event`             INT(11) NOT NULL COMMENT 'Sequência 1..N por tentativa',
  `kind`              CHAR(1) NOT NULL COMMENT 'S enviado · A autorizada · R rejeitada · C cancelada · K cancelamento em voo · F falha explícita',
  `authority_code`    VARCHAR(10) DEFAULT NULL COMMENT 'Código cru do fisco (E0xxx / HTTP)',
  `message`           VARCHAR(255) DEFAULT NULL,
  `dh`                DATETIME DEFAULT NULL COMMENT 'Data/hora informada pelo fisco (dhProc/dhEvento)',
  `source`            CHAR(1) NOT NULL COMMENT 'P resposta direta ao nosso pedido · Q consulta',
  `invoice_event`     INT(11) DEFAULT NULL COMMENT 'Efeito produzido em tb_invoice_event (C); NULL = sem efeito ou pendência',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`, `event`),
  UNIQUE KEY `uk_invoice_service_transmission_event_dh` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`, `kind`, `dh`),
  CONSTRAINT `fk_invoice_service_transmission_event_tx` FOREIGN KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`)
    REFERENCES `tb_invoice_service_transmission` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
