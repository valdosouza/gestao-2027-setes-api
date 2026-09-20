-- 055 — Onda 2 da fase Primeiro Cliente: boleto × Banco Inter (Cobrança v3).
-- Decisões D-I1…D-I19 (prompt_onda2_banco_inter.md; Valdo 2026-09-19, "siga as
-- recomendações"). Parecer do guardião: "integrar o boleto com o Inter" são TRÊS
-- conceitos, separados pelo fato gerador — e o boleto interno (tb_bank_slip +
-- _title + _event) NÃO muda de forma: só recebe EFEITOS (L/C, source 'A').
--
-- Collation utf8mb4_general_ci: as três fazem JOIN com tabelas do baseline
-- (tb_bank_account, tb_bank_slip) — regra do PADROES_BANCO.

-- A. O CANAL API da conta — "esta conta corrente fala com o seu banco por API".
-- Fato gerador: a habilitação da aplicação no portal do banco. Especialização por
-- PK de tb_bank_account (1 canal por conta), como tb_settlement_rule especializa o
-- vínculo. Pendurado na CONTA, não na carteira nem na forma (alerta §7 da fase):
-- N carteiras da mesma conta usam a MESMA credencial, e o mesmo canal servirá ao
-- extrato/saldo por API amanhã.
-- O que NÃO está aqui, por decisão (D-I3): client_secret, certificado e chave
-- privada — vivem em SECRETS_PATH pela peça @shared/secret-store, com caminho
-- derivado desta PK + ambiente. Provider = derivado do banco da conta
-- (tb_bank.number — D-I2); conta do header = number + number_dv (D-I14);
-- "webhook cadastrado" = estado REMOTO, consulta-se (nunca flag).
CREATE TABLE IF NOT EXISTS `tb_bank_account_channel` (
  `tb_bank_account_id` INT NOT NULL,
  `tb_institution_id`  INT NOT NULL,
  `environment`        CHAR(1) NOT NULL DEFAULT 'S' COMMENT 'S sandbox / P produção — a Onda 4 vira P',
  `client_id`          VARCHAR(100) DEFAULT NULL COMMENT 'Identificador público da aplicação OAuth (o secret NÃO é dado)',
  `inbound_token`      CHAR(48) NOT NULL COMMENT 'Chave que NÓS emitimos para o banco nos chamar (path do webhook) — precedente tb_sync_api_key',
  `active`             CHAR(1) NOT NULL DEFAULT 'S',
  `created_at`         DATETIME DEFAULT NULL,
  `updated_at`         DATETIME DEFAULT NULL,
  `deleted`            CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_bank_account_id`, `tb_institution_id`),
  UNIQUE KEY `uk_bank_channel_inbound` (`inbound_token`),
  CONSTRAINT `fk_bank_channel_account`
    FOREIGN KEY (`tb_bank_account_id`, `tb_institution_id`)
    REFERENCES `tb_bank_account` (`id`, `tb_institution_id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;

-- B. A APRESENTAÇÃO do boleto ao banco — "um boleto foi apresentado ao banco para
-- registro". Fato gerador: o envio (POST emitir → codigoSolicitacao). 1 boleto × N
-- apresentações (`attempt`): FALHA_EMISSAO + retentativa = attempt 2 no MESMO
-- boleto, mesmo our_number (D16 da fase: nosso número sobrevive, o do banco muda).
-- Imutável após nascer, com UMA exceção deliberada (D-I6): os dados que o banco só
-- devolve na CONSULTA (nosso número do banco, linha digitável, código de barras,
-- Pix) são WRITE-ONCE — preenchidos de NULL para valor uma vez, nunca reescritos.
-- São atributos do instrumento registrado, imutáveis no banco também.
-- `environment` CONGELADO do canal no envio: o mesmo código em sandbox e produção
-- são universos diferentes. `request_code` UNIQUE por institution: toda notificação
-- entra por ela. NULL só quando o POST foi recusado sem código (a tentativa recusada
-- também é história).
CREATE TABLE IF NOT EXISTS `tb_bank_slip_registration` (
  `tb_institution_id` INT NOT NULL,
  `tb_bank_slip_id`   INT NOT NULL,
  `attempt`           INT NOT NULL COMMENT 'Sequência 1..N por boleto',
  `environment`       CHAR(1) NOT NULL COMMENT 'S/P congelado do canal no envio',
  `request_code`      VARCHAR(36) DEFAULT NULL COMMENT 'codigoSolicitacao do banco; NULL = POST recusado',
  `bank_our_number`   VARCHAR(11) DEFAULT NULL COMMENT 'nossoNumero DO BANCO (write-once)',
  `digitable_line`    VARCHAR(47) DEFAULT NULL COMMENT 'write-once',
  `barcode`           VARCHAR(44) DEFAULT NULL COMMENT 'write-once',
  `pix_copy_paste`    TEXT DEFAULT NULL COMMENT 'write-once',
  `pix_txid`          VARCHAR(35) DEFAULT NULL COMMENT 'write-once',
  `tb_user_id`        INT DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_bank_slip_id`, `attempt`),
  UNIQUE KEY `uk_bank_slip_registration_request` (`tb_institution_id`, `request_code`),
  CONSTRAINT `fk_bank_slip_registration_slip`
    FOREIGN KEY (`tb_bank_slip_id`, `tb_institution_id`)
    REFERENCES `tb_bank_slip` (`id`, `tb_institution_id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;

-- C. A VOZ do banco — "o banco disse algo sobre essa apresentação". Append-only,
-- uma linha por situação informada (webhook ou consulta). `kind` é a NOSSA leitura;
-- `bank_status` é a situação CRUA como o banco escreveu (a leitura pode mudar, o
-- que ele disse não). Situação desconhecida → o adaptador falha alto, não inventa.
-- `slip_event` = causa → efeito: o nº do evento L ou C em tb_bank_slip_event que
-- esta fala produziu (precedente tb_check_event.payment_event). NULL quando o
-- efeito não pôde acontecer (baixa recusada pelas nossas regras — D-I10): o fato do
-- terceiro nunca se perde, e é o NULL que torna a pendência visível na tela.
-- Idempotência por construção: a peça só grava quando (kind, dt_bank_status)
-- difere do último da apresentação; o UNIQUE é o cinto. Lock: o boleto (FOR UPDATE)
-- ANTES de ler o último evento — dois webhooks simultâneos serializam no boleto.
CREATE TABLE IF NOT EXISTS `tb_bank_slip_registration_event` (
  `tb_institution_id` INT NOT NULL,
  `tb_bank_slip_id`   INT NOT NULL,
  `attempt`           INT NOT NULL,
  `event`             INT NOT NULL,
  `kind`              CHAR(1) NOT NULL COMMENT 'S enviado · G registrado (A_RECEBER) · R recebido · M marcado recebido · A atrasado · P protesto · C cancelado no banco · V expirado · F falha (FALHA_EMISSAO / POST recusado)',
  `bank_status`       VARCHAR(30) DEFAULT NULL COMMENT 'Situação crua do banco',
  `dt_bank_status`    DATETIME DEFAULT NULL COMMENT 'dataHoraSituacao / dataSituacao',
  `source`            CHAR(1) NOT NULL COMMENT 'W webhook · Q consulta · P resposta direta ao nosso POST/cancelamento',
  `paid_value`        DECIMAL(10,2) DEFAULT NULL COMMENT 'valorTotalRecebido (R)',
  `paid_by`           CHAR(1) DEFAULT NULL COMMENT 'B boleto · X pix (origemRecebimento)',
  `slip_event`        INT DEFAULT NULL COMMENT 'Efeito produzido em tb_bank_slip_event (L ou C); NULL = pendência',
  `message`           VARCHAR(255) DEFAULT NULL,
  `tb_user_id`        INT DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_bank_slip_id`, `attempt`, `event`),
  UNIQUE KEY `uk_bank_slip_registration_event_status` (`tb_institution_id`, `tb_bank_slip_id`, `attempt`, `kind`, `dt_bank_status`),
  CONSTRAINT `fk_bank_slip_registration_event_reg`
    FOREIGN KEY (`tb_institution_id`, `tb_bank_slip_id`, `attempt`)
    REFERENCES `tb_bank_slip_registration` (`tb_institution_id`, `tb_bank_slip_id`, `attempt`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
