-- =============================================================
-- Migration: 001_baseline.sql
-- Gerada a partir do schema real gestao_setes (MariaDB 10.11)
-- Ajustes aplicados:
--   1. Todas as tabelas com CREATE TABLE IF NOT EXISTS
--   2. Coluna `deleted` reposicionada corretamente em todas as tabelas
--   3. Charset padronizado para utf8mb4
--   4. Tabelas `users` e `audit_log` removidas (substituidas por tb_user e tb_audit_log)
--   5. tb_audit_log adicionada seguindo padrao tb_ do projeto
--   6. Triggers removidos (migration separada: 002_triggers.sql)
-- =============================================================

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS `tb_accounting` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `active` char(1) NOT NULL DEFAULT 'N',
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_institution_id` (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_bank` (
  `id` int(11) NOT NULL,
  `number` varchar(3) NOT NULL,
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  UNIQUE KEY `number` (`number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_bank_account` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_bank_id` int(11) NOT NULL,
  `dt_opening` date DEFAULT NULL,
  `agency` varchar(8) DEFAULT NULL,
  `agency_dv` varchar(2) DEFAULT NULL,
  `number` varchar(10) DEFAULT NULL,
  `number_dv` varchar(2) DEFAULT NULL,
  `phone` varchar(10) DEFAULT NULL,
  `manager` varchar(25) DEFAULT NULL,
  `limit_value` decimal(10,2) DEFAULT NULL,
  `dt_contract` date DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_bank_charge_kind` (
  `id` int(11) NOT NULL,
  `tb_bank_id` int(11) NOT NULL,
  `abbreviation` varchar(10) DEFAULT NULL,
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_bank_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_bank_charge_slip` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_bank_account_id` int(11) NOT NULL,
  `tb_bank_charge_ticket_id` int(11) NOT NULL,
  `tb_bank_charge_kind_id` int(11) NOT NULL,
  `agreement` varchar(30) DEFAULT NULL,
  `variacao` int(11) DEFAULT NULL,
  `accept` char(1) DEFAULT NULL,
  `layout` int(11) DEFAULT NULL,
  `layout_shipping` varchar(10) DEFAULT NULL,
  `instruction_1` varchar(60) DEFAULT NULL,
  `instruction_2` varchar(60) DEFAULT NULL,
  `instruction` blob DEFAULT NULL,
  `aliq_discount` decimal(10,2) DEFAULT NULL,
  `aliq_interest` decimal(10,2) DEFAULT NULL,
  `aliq_late` decimal(10,2) DEFAULT NULL,
  `value_late_min` decimal(10,2) DEFAULT NULL,
  `value_fine` decimal(10,2) DEFAULT NULL,
  `aliq_fine` decimal(10,2) DEFAULT NULL,
  `value_rate` decimal(10,2) DEFAULT NULL,
  `path_files` varchar(100) DEFAULT NULL,
  `name_files` varchar(100) DEFAULT NULL,
  `protest` char(1) DEFAULT NULL,
  `day_protest` int(11) DEFAULT NULL,
  `payment_local` varchar(60) DEFAULT NULL,
  `transmission_code` varchar(30) DEFAULT NULL,
  `benefic_post` varchar(5) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_bank_charge_ticket` (
  `id` int(11) NOT NULL,
  `tb_bank_id` int(11) NOT NULL,
  `number` varchar(50) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `emission_by` char(1) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_bank_id`,`number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_bank_historic` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_bank_id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_bank_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_brand` (
  `id` int(11) NOT NULL,
  `description` varchar(100) NOT NULL,
  `tb_provider_id` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_button` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `Description` varchar(100) DEFAULT NULL,
  `link_url` varchar(255) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_carrier` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `active` char(1) NOT NULL DEFAULT 'S',
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_carrier_ibfk_2` (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_cashier` (
  `id` int(11) NOT NULL DEFAULT 0,
  `tb_institution_id` int(11) NOT NULL DEFAULT 0,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `dt_record` datetime DEFAULT NULL,
  `tb_userid` int(11) DEFAULT NULL,
  `hr_begin` timestamp NULL DEFAULT NULL ON UPDATE current_timestamp(),
  `hr_end` timestamp NULL DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_cashier_items` (
  `id` int(11) NOT NULL DEFAULT 0,
  `tb_institution_id` int(11) NOT NULL DEFAULT 0,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_cashier_id` int(11) NOT NULL DEFAULT 0,
  `kind` char(1) DEFAULT NULL,
  `tb_payment_types_id` int(11) DEFAULT NULL,
  `SET_VALUE` decimal(10,2) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`,`tb_cashier_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_cest` (
  `cest` varchar(7) NOT NULL,
  `ncm` varchar(8) DEFAULT NULL,
  `description` varchar(200) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`cest`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_cfop` (
  `id` varchar(10) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `concise` varchar(60) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `register` int(11) DEFAULT NULL,
  `way` varchar(1) DEFAULT NULL,
  `jurisdiction` varchar(1) DEFAULT NULL,
  `note` blob DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_cfop_to_cfop` (
  `tb_cfop_id_ori` varchar(10) NOT NULL,
  `tb_cfop_id_des` varchar(10) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_cfop_id_ori`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_clin_module` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `sequence_id` int(11) DEFAULT 0,
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_collaborator` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `dt_admission` date DEFAULT NULL,
  `dt_resignation` date DEFAULT NULL,
  `salary` decimal(10,2) DEFAULT NULL,
  `pis` varchar(11) DEFAULT NULL,
  `fahters_name` varchar(100) DEFAULT NULL,
  `mothers_name` varchar(100) DEFAULT NULL,
  `vote_number` varchar(20) DEFAULT NULL,
  `vote_zone` varchar(3) DEFAULT NULL,
  `vote_section` varchar(3) DEFAULT NULL,
  `military_certificate` varchar(15) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_color` (
  `id` int(11) NOT NULL,
  `description` varchar(100) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_config` (
  `tb_institution_id` int(11) NOT NULL,
  `field` varchar(50) NOT NULL,
  `tb_user_id` int(11) DEFAULT NULL,
  `kind` char(1) DEFAULT NULL,
  `content` varchar(100) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`field`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_config_nfe` (
  `tb_institution_id` int(11) NOT NULL,
  `layer` char(1) DEFAULT NULL,
  `version` varchar(10) NOT NULL,
  `type_emission` char(1) DEFAULT NULL,
  `certificate` varchar(100) DEFAULT NULL,
  `certificate_serie` varchar(50) NOT NULL,
  `certificate_pass` varchar(50) NOT NULL,
  `certificate_path` varchar(255) NOT NULL,
  `set_view_msg` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_config_nfe_55` (
  `tb_institution_id` int(11) NOT NULL,
  `orientation` char(1) DEFAULT NULL,
  `receipt_posit` char(1) DEFAULT NULL,
  `set_invoice` char(1) DEFAULT NULL,
  `set_duplicate` char(1) DEFAULT NULL,
  `hide_first_parcel` char(1) DEFAULT NULL,
  `sendNfeToaccounting` char(1) DEFAULT NULL,
  `sendNfeToyourSelf` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_config_nfe_65` (
  `tb_institution_id` int(11) NOT NULL,
  `id_token_nfce` varchar(10) DEFAULT NULL,
  `token_nfce` varchar(50) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_contact` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_entity_owner_id` int(11) NOT NULL,
  `active` char(1) NOT NULL DEFAULT 'N',
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_entity_owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_country` (
  `id` int(11) NOT NULL,
  `name` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_crashlytics` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tb_institution_id` int(11) NOT NULL,
  `tb_user_id` int(11) NOT NULL,
  `origen` varchar(100) NOT NULL,
  `message` blob DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_ctrl_icms_st` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_item_orig` int(11) DEFAULT NULL,
  `tb_product_id` int(11) DEFAULT NULL,
  `vbc_st_ret` decimal(10,6) DEFAULT NULL,
  `pst` decimal(10,2) DEFAULT NULL,
  `vicms_substituto` decimal(10,6) DEFAULT NULL,
  `vicms_st_ret` decimal(10,6) DEFAULT NULL,
  `tb_order_item_dest` int(11) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_deter_base_tax_icms` (
  `id` char(2) NOT NULL DEFAULT '',
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_deter_base_tax_icms_st` (
  `id` char(2) NOT NULL DEFAULT '',
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_devices` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `identification` varchar(255) NOT NULL,
  `description` varchar(50) DEFAULT NULL,
  `tb_user_id` int(11) DEFAULT NULL,
  `terminal` int(11) DEFAULT NULL,
  `serie_nf` varchar(10) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `active` char(1) DEFAULT NULL,
  `shelf_life` date DEFAULT NULL,
  `app_name` varchar(255) DEFAULT NULL,
  `download` char(1) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`identification`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_discharge_icms` (
  `id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_entity` (
  `id` int(11) NOT NULL,
  `name_company` varchar(100) DEFAULT '',
  `nick_trade` varchar(100) DEFAULT '',
  `aniversary` date DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `tb_line_business_id` int(11) DEFAULT NULL,
  `tb_linebusiness_id` int(11) DEFAULT NULL,
  `note` blob DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `nick_trade` (`nick_trade`),
  KEY `name_company` (`name_company`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_customer` (
  `id` int(11) NOT NULL DEFAULT 0,
  `tb_institution_id` int(11) NOT NULL DEFAULT 0,
  `tb_salesman_id` int(11) DEFAULT NULL,
  `tb_vendor_id` int(11) DEFAULT NULL,
  `tb_carrier_id` int(11) DEFAULT NULL,
  `credit_status` char(1) DEFAULT NULL,
  `credit_value` decimal(10,2) DEFAULT NULL,
  `wallet` char(1) DEFAULT NULL,
  `consumer` char(1) DEFAULT NULL,
  `multiplier` decimal(10,2) DEFAULT NULL,
  `by_pass_st` char(1) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  KEY `updated_at` (`updated_at`),
  KEY `tb_customer_ibfk_2` (`tb_salesman_id`),
  CONSTRAINT `tb_customer_ibfk_1` FOREIGN KEY (`id`) REFERENCES `tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_customer_ibfk_2` FOREIGN KEY (`tb_salesman_id`) REFERENCES `tb_entity` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_company` (
  `id` int(11) NOT NULL,
  `cnpj` char(14) NOT NULL DEFAULT '0',
  `ie` varchar(45) DEFAULT NULL,
  `im` varchar(45) DEFAULT NULL,
  `iest` varchar(45) DEFAULT NULL,
  `dt_foundation` date DEFAULT NULL,
  `crt` char(1) DEFAULT NULL,
  `crt_modal` char(1) DEFAULT NULL,
  `ind_ie_destinatario` varchar(1) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `iss_ind_exig` char(2) DEFAULT NULL,
  `iss_retencao` char(1) DEFAULT NULL,
  `iss_inc_fiscal` char(1) DEFAULT NULL,
  `iss_process_number` varchar(50) DEFAULT NULL,
  `send_xml_nfe_only` char(1) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  UNIQUE KEY `cnpj` (`cnpj`),
  CONSTRAINT `tb_company_ibfk_1` FOREIGN KEY (`id`) REFERENCES `tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_entity_has_entity` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_entity_owner_id` int(11) NOT NULL,
  `tb_entity_child_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_entity_owner_id`,`tb_entity_child_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_entity_has_mailing` (
  `tb_entity_id` int(11) NOT NULL,
  `tb_mailing_id` int(11) NOT NULL,
  `tb_mailing_group_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_entity_id`,`tb_mailing_id`,`tb_mailing_group_id`),
  KEY `tb_mailing_id` (`tb_mailing_id`),
  KEY `tb_mailing_group_id` (`tb_mailing_group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_entity_has_stock_list` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_entity_id` int(11) NOT NULL,
  `tb_stock_list_id` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_entity_id`,`tb_stock_list_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_entity_seq` (
  `id` int(11) NOT NULL,
  `used` char(1) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_financial` (
  `id` int(11) DEFAULT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `parcel` int(11) NOT NULL,
  `dt_expiration` date DEFAULT NULL,
  `tb_payment_types_id` int(11) NOT NULL,
  `tag_value` decimal(10,2) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_order_id`,`terminal`,`parcel`),
  KEY `tb_order_id` (`tb_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_financial_bills` (
  `id` int(11) DEFAULT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `parcel` int(11) NOT NULL,
  `tb_financial_plans_id` int(11) NOT NULL DEFAULT 0,
  `number` varchar(60) DEFAULT NULL,
  `kind` varchar(2) DEFAULT NULL,
  `situation` varchar(1) DEFAULT NULL,
  `operation` varchar(1) DEFAULT NULL,
  `stage` varchar(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_order_id`,`terminal`,`parcel`),
  KEY `tb_order_id` (`tb_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_financial_payment` (
  `id` int(11) DEFAULT 0,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `parcel` int(11) NOT NULL,
  `interest_value` decimal(10,2) DEFAULT NULL,
  `late_value` decimal(10,2) DEFAULT NULL,
  `discount_aliquot` decimal(10,2) DEFAULT NULL,
  `paid_value` decimal(10,2) DEFAULT NULL,
  `dt_payment` date DEFAULT NULL,
  `dt_real_payment` date DEFAULT NULL,
  `settled` varchar(1) DEFAULT NULL,
  `tb_financial_plans_id` int(11) NOT NULL DEFAULT 0,
  `settled_code` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `tb_payment_types_id` int(11) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_order_id`,`terminal`,`parcel`),
  KEY `tb_order_id` (`tb_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_financial_plans` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `posit_level` varchar(50) DEFAULT NULL,
  `description` varchar(100) DEFAULT NULL,
  `source_` varchar(1) DEFAULT NULL,
  `kind` varchar(1) DEFAULT NULL,
  `cluster` varchar(1) DEFAULT NULL,
  `active` char(1) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `source_` (`source_`),
  KEY `kind` (`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_financial_statement` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_bank_account_id` int(11) NOT NULL,
  `dt_record` date DEFAULT NULL,
  `tb_bank_historic_id` int(11) NOT NULL,
  `credit_value` decimal(10,2) DEFAULT NULL,
  `debit_value` decimal(10,2) DEFAULT NULL,
  `manual_history` varchar(100) DEFAULT NULL,
  `kind` char(1) DEFAULT NULL,
  `settled_code` int(11) DEFAULT NULL,
  `tb_user_id` int(11) DEFAULT NULL,
  `future` char(1) DEFAULT NULL,
  `dt_original` date DEFAULT NULL,
  `doc_reference` char(30) DEFAULT NULL,
  `conferred` char(1) DEFAULT NULL,
  `tb_payment_types_id` int(11) DEFAULT NULL,
  `tb_financial_plans_id_cre` int(11) NOT NULL DEFAULT 0,
  `tb_financial_plans_id_deb` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_freight_mode` (
  `id` char(1) NOT NULL DEFAULT '',
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_images` (
  `tb_institution_id` int(11) NOT NULL,
  `album` varchar(50) NOT NULL DEFAULT 'ni',
  `file_name` varchar(100) NOT NULL DEFAULT '',
  `sequence` int(11) NOT NULL DEFAULT 0,
  `tb_entity_id` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`album`,`file_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution` (
  `id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_category` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `description` varchar(100) NOT NULL,
  `posit_level` varchar(40) DEFAULT NULL,
  `kind` char(1) DEFAULT NULL,
  `active` varchar(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_category_ibfk_1` (`tb_institution_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `tb_category_ibfk_1` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_bank` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_bank_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_brand` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_brand_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_brand_id`),
  KEY `tb_brand_id` (`tb_brand_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `tb_institution_has_brand_ibfk_1` FOREIGN KEY (`tb_brand_id`) REFERENCES `tb_brand` (`id`),
  CONSTRAINT `tb_institution_has_brand_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_color` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_color_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_color_id`),
  KEY `tb_color_id` (`tb_color_id`),
  CONSTRAINT `tb_institution_has_color_ibfk_1` FOREIGN KEY (`tb_color_id`) REFERENCES `tb_color` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_entity` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_entity_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_entity_id`),
  KEY `tb_entity_id` (`tb_entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_insc_st` (
  `tb_state_id` int(11) NOT NULL DEFAULT 0,
  `tb_institution_id` int(11) NOT NULL,
  `ie_st` varchar(45) NOT NULL,
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_state_id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_interface` (
  `id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `kind` varchar(26) DEFAULT NULL,
  `position` varchar(10) DEFAULT 'NULL',
  `img_index` int(11) NOT NULL,
  `acao_botao` varchar(100) DEFAULT 'NULL',
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `position` (`position`),
  KEY `kind` (`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_invoice` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `issuer` int(11) NOT NULL,
  `kind_emis` varchar(50) DEFAULT NULL,
  `finality` varchar(2) DEFAULT NULL,
  `number` varchar(20) DEFAULT NULL,
  `serie` varchar(10) DEFAULT NULL,
  `tb_cfop_id` varchar(10) DEFAULT NULL,
  `tb_entity_id` int(11) NOT NULL,
  `dt_emission` date NOT NULL,
  `value` decimal(10,2) DEFAULT NULL,
  `model` varchar(2) DEFAULT NULL,
  `note` blob DEFAULT NULL,
  `status` char(1) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`),
  KEY `tb_cfop_id` (`tb_cfop_id`),
  KEY `tb_entity_id` (`tb_entity_id`),
  KEY `tb_institution_id` (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_invoice_has_purchase` (
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_institution_id` int(11) NOT NULL,
  `tb_invoice_id` int(11) NOT NULL,
  `tb_invoice_item_id` int(11) NOT NULL,
  `tb_order_purchase_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`terminal`,`tb_institution_id`,`tb_invoice_id`,`tb_invoice_item_id`,`tb_order_purchase_id`,`tb_order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_invoice_merchandise` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `dt_exit` date DEFAULT NULL,
  `tm_exit` time DEFAULT NULL,
  `base_icms_value` decimal(10,2) DEFAULT NULL,
  `icms_value` decimal(10,2) DEFAULT NULL,
  `base_icms_st_value` decimal(10,2) DEFAULT NULL,
  `icms_st_value` decimal(10,2) DEFAULT NULL,
  `total_value` decimal(10,2) DEFAULT NULL,
  `freight_value` decimal(10,2) DEFAULT NULL,
  `insurance_value` decimal(10,2) DEFAULT NULL,
  `expenses_value` decimal(10,2) DEFAULT NULL,
  `ipi_value` decimal(10,2) DEFAULT NULL,
  `discount_value` decimal(10,2) NOT NULL,
  `total_qtty` decimal(10,3) DEFAULT NULL,
  `indPres` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`),
  KEY `tb_institution_id` (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_invoice_obs` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_invoice_id` int(11) NOT NULL,
  `kind` char(1) DEFAULT NULL,
  `note` blob NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`,`tb_invoice_id`),
  KEY `tb_invoice_id` (`tb_invoice_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  CONSTRAINT `tb_invoice_obs_ibfk_1` FOREIGN KEY (`tb_invoice_id`) REFERENCES `tb_invoice` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT `tb_invoice_obs_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_invoice_rectification` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `tb_invoice_id` int(11) NOT NULL,
  `dt_record` date DEFAULT NULL,
  `nr_key` varchar(50) DEFAULT NULL,
  `protocol` varchar(50) DEFAULT NULL,
  `tb_state_id` int(11) DEFAULT NULL,
  `sequencce` int(11) DEFAULT NULL,
  `note` blob DEFAULT NULL,
  `status_code` int(11) DEFAULT NULL,
  `motive` varchar(60) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_invoice_return_55` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `number` varchar(10) DEFAULT NULL,
  `serie` varchar(10) DEFAULT NULL,
  `status_code` int(11) NOT NULL,
  `file_name` varchar(255) DEFAULT NULL,
  `motive` varchar(60) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_invoice_return_65` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `number` varchar(10) NOT NULL,
  `serie` varchar(10) NOT NULL,
  `nr_lot` int(11) NOT NULL,
  `synchronous` char(1) DEFAULT NULL,
  `emissi_type` char(1) DEFAULT NULL,
  `format_type` char(1) DEFAULT NULL,
  `presen_indi` char(1) DEFAULT NULL,
  `status_code` int(11) NOT NULL,
  `file_name` varchar(255) DEFAULT NULL,
  `motive` varchar(60) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_invoice_return_service` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `number` varchar(10) NOT NULL,
  `nr_rps` int(11) NOT NULL,
  `nr_lot` int(11) NOT NULL,
  `protocol` varchar(50) DEFAULT NULL,
  `code_verif` varchar(15) DEFAULT NULL,
  `kind` char(1) DEFAULT NULL,
  `synchronous` char(1) DEFAULT NULL,
  `status_code` int(11) NOT NULL,
  `file_name` varchar(255) DEFAULT NULL,
  `motive` varchar(60) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_invoice_shipping` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `total_qtty` decimal(10,3) DEFAULT NULL,
  `sort_tag` varchar(10) DEFAULT NULL,
  `brand_tag` varchar(10) DEFAULT NULL,
  `gross_weight` varchar(10) DEFAULT NULL,
  `net_weight` varchar(10) DEFAULT NULL,
  `volume_number` varchar(8) DEFAULT NULL,
  `vehicle_plaque` varchar(8) DEFAULT NULL,
  `state_plaque` varchar(2) DEFAULT NULL,
  `rntc_plaque` varchar(20) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_institution_id` (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_iteration` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `detail` blob DEFAULT NULL,
  `kind` char(1) DEFAULT NULL,
  `tb_situation_id` int(11) DEFAULT NULL,
  `path_attachament` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `tb_customer_id` int(11) DEFAULT NULL,
  `tb_user_id` int(11) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`),
  KEY `tb_situation_id` (`tb_situation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_iteration_attachment` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_iteration_id` int(11) NOT NULL,
  `path_file` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`tb_iteration_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_iteration_has_iteration` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_iteration_id_master` int(11) NOT NULL,
  `tb_iteration_id_detail` int(11) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_order_id`,`tb_iteration_id_master`,`tb_iteration_id_detail`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_kickback` (
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `parcel` int(11) NOT NULL,
  `dt_record` date DEFAULT NULL,
  `tb_customer_id` int(11) NOT NULL,
  `tb_collaborator_id` int(11) NOT NULL,
  `historic` varchar(100) DEFAULT NULL,
  `base_value` decimal(10,2) DEFAULT NULL,
  `aliq` decimal(10,2) DEFAULT NULL,
  `vl_payment` decimal(10,2) DEFAULT NULL,
  `dt_payment` date DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`terminal`,`tb_order_id`,`tb_order_item_id`,`parcel`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_kind` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `description` varchar(50) DEFAULT NULL,
  `detail` blob DEFAULT NULL,
  `cost_owner` char(1) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_linebusiness` (
  `id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_linebusiness` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_linebusiness_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_linebusiness_id`),
  KEY `tb_institution_has_linebusiness_ibfk_1` (`tb_linebusiness_id`),
  CONSTRAINT `tb_institution_has_linebusiness_ibfk_1` FOREIGN KEY (`tb_linebusiness_id`) REFERENCES `tb_linebusiness` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_institution_has_linebusiness_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_log_operation` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_user_id` int(11) NOT NULL,
  `log_timestamp` datetime DEFAULT NULL,
  `log_interface` varchar(100) DEFAULT NULL,
  `log_operation` varchar(100) DEFAULT NULL,
  `log_description` varchar(255) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_mailing` (
  `id` int(11) NOT NULL,
  `email` varchar(100) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `email_2` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_mailing_group` (
  `id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_mailing_seq` (
  `id` int(11) NOT NULL,
  `used` char(1) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_measure` (
  `id` int(11) NOT NULL,
  `description` varchar(100) NOT NULL,
  `abbreviation` varchar(5) DEFAULT NULL,
  `escale` decimal(10,2) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_measure` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_measure_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_measure_id`),
  KEY `tb_measure_id` (`tb_measure_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `tb_institution_has_measure_ibfk_1` FOREIGN KEY (`tb_measure_id`) REFERENCES `tb_measure` (`id`),
  CONSTRAINT `tb_institution_has_measure_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_merchandise_has_provider` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_merchandise_id` int(11) NOT NULL,
  `tb_provider_id` int(11) NOT NULL,
  `product_provider` varchar(50) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_merchandise_id`,`tb_provider_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_merchandise_has_self` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_master_id` int(11) NOT NULL,
  `tb_detail_id` int(11) NOT NULL,
  `quantity` decimal(10,4) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_master_id`,`tb_detail_id`),
  KEY `tb_detail_id` (`tb_detail_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_module` (
  `id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `technical_name` varchar(50) NOT NULL,
  `img_index` int(11) DEFAULT 0,
  `acao_botao` varchar(101) DEFAULT 'NULL',
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_module` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_modules_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_modules_id`),
  KEY `tb_modules_id` (`tb_modules_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  KEY `active` (`active`),
  CONSTRAINT `tb_institution_has_module_ibfk_1` FOREIGN KEY (`tb_modules_id`) REFERENCES `tb_module` (`id`),
  CONSTRAINT `tb_institution_has_module_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_module_has_interface` (
  `tb_module_id` int(11) NOT NULL,
  `tb_interface_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_module_id`,`tb_interface_id`),
  KEY `tb_interfaces_id` (`tb_interface_id`),
  CONSTRAINT `tb_module_has_interface_ibfk_1` FOREIGN KEY (`tb_interface_id`) REFERENCES `tb_interface` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT `tb_module_has_interface_ibfk_2` FOREIGN KEY (`tb_module_id`) REFERENCES `tb_module` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_msg_return_nfe` (
  `id` int(11) NOT NULL,
  `kind` char(1) DEFAULT NULL,
  `description` varchar(100) DEFAULT NULL,
  `interno` int(11) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_ncm` (
  `number` varchar(10) NOT NULL,
  `description` varchar(150) DEFAULT NULL,
  `exc` varchar(5) DEFAULT NULL,
  `tabela` int(11) DEFAULT NULL,
  `aliq_nac` decimal(10,3) DEFAULT NULL,
  `aliq_imp` decimal(10,3) DEFAULT NULL,
  `aliq_est` decimal(10,3) DEFAULT NULL,
  `aliq_mun` decimal(10,3) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_nfe_events` (
  `id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_nfe_events_sent` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `number` varchar(15) DEFAULT NULL,
  `nfe_key` varchar(100) DEFAULT NULL,
  `tb_nfe_events_id` int(11) DEFAULT NULL,
  `dt_record` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `Sequence` varchar(10) DEFAULT NULL,
  `justification` varchar(255) DEFAULT NULL,
  `status` varchar(3) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_nfe_sequences` (
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `serie` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `id` int(11) NOT NULL,
  `updated_at` datetime DEFAULT current_timestamp(),
  `created_at` datetime DEFAULT current_timestamp(),
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`terminal`,`serie`,`tb_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_nfe_series` (
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `serie` int(11) NOT NULL,
  `updated_at` datetime DEFAULT current_timestamp(),
  `created_at` datetime DEFAULT current_timestamp(),
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`terminal`,`serie`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_no_doc_number` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `reference` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`reference`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_observation` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `note` blob DEFAULT NULL,
  `general` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_bonus` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_salesman_id` int(11) NOT NULL,
  `number` int(11) DEFAULT NULL,
  `tb_customer_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`,`tb_salesman_id`),
  KEY `tb_customer_id` (`tb_customer_id`),
  KEY `tb_salesman_id` (`tb_salesman_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_cost` (
  `id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_product_id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `calc_basis` decimal(10,3) DEFAULT NULL,
  `method` char(1) DEFAULT NULL,
  `index_value` decimal(10,2) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_order_id`,`tb_order_item_id`,`terminal`),
  KEY `tb_order_item_id` (`tb_order_item_id`),
  KEY `tb_product_id` (`tb_product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_has_purchase` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_order_to_buy_id` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_order_id`,`tb_order_item_id`),
  KEY `tb_order_id` (`tb_order_id`),
  KEY `tb_order_item_id` (`tb_order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_has_reserved` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_stock_reserved_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_order_id`,`tb_order_item_id`,`tb_stock_reserved_id`),
  KEY `tb_order_id` (`tb_order_id`),
  KEY `tb_order_item_id` (`tb_order_item_id`),
  KEY `tb_stock_reserved_id` (`tb_stock_reserved_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_cofins` (
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `cst` varchar(2) DEFAULT NULL,
  `base_value` decimal(15,2) DEFAULT NULL,
  `aliq_value` decimal(5,2) DEFAULT NULL,
  `tag_value` decimal(15,2) DEFAULT NULL,
  `qt_sale_qtty` decimal(16,4) DEFAULT NULL,
  `qt_aliq_value` decimal(15,4) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`,`tb_order_item_id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_detached` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `nr_item` int(11) DEFAULT NULL,
  `description` varchar(100) DEFAULT NULL,
  `tb_measure_id` int(11) DEFAULT NULL,
  `parts_flavor` int(11) DEFAULT NULL,
  `quantity` decimal(10,4) DEFAULT NULL,
  `unit_value` decimal(10,6) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_detail` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `tb_order_item_id` int(11) DEFAULT NULL,
  `tb_order_item_detached_id` int(11) NOT NULL,
  `kind` varchar(50) DEFAULT NULL,
  `note` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_detail_observation` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `tb_order_item_detail_id` int(11) DEFAULT NULL,
  `tb_rest_group_has_observation_id` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_detail_optional` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `tb_order_item_detail_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) DEFAULT NULL,
  `tb_product_id` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_detail_remove` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `tb_order_item_detail_id` int(11) DEFAULT NULL,
  `tb_product_id` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_flex` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_salesman_id` int(11) NOT NULL DEFAULT 0,
  `original_value` decimal(10,4) DEFAULT 0.0000,
  `real_value` decimal(10,4) DEFAULT 0.0000,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`terminal`,`tb_salesman_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_icms` (
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `cst` varchar(3) DEFAULT NULL,
  `origem` char(1) DEFAULT NULL,
  `determ_base` char(1) DEFAULT NULL,
  `determ_base_st` char(1) DEFAULT NULL,
  `discharge` int(11) DEFAULT NULL,
  `aliq_rd_base` decimal(10,2) DEFAULT NULL,
  `base_value` decimal(10,6) DEFAULT NULL,
  `aliq` decimal(10,2) DEFAULT NULL,
  `aliq_rd` decimal(10,2) DEFAULT NULL,
  `value` decimal(10,6) DEFAULT NULL,
  `aliq_rd_base_st` decimal(10,2) DEFAULT NULL,
  `base_value_st` decimal(10,6) DEFAULT NULL,
  `aliq_st` decimal(10,2) DEFAULT NULL,
  `aliq_rd_st` decimal(10,2) DEFAULT NULL,
  `value_st` decimal(10,6) DEFAULT NULL,
  `mva` decimal(10,6) DEFAULT NULL,
  `withheld_base_value` decimal(10,6) DEFAULT NULL,
  `withheld_value` decimal(10,6) DEFAULT NULL,
  `withheld_base_value_st` decimal(10,6) DEFAULT NULL,
  `withheld_value_st` decimal(10,6) DEFAULT NULL,
  `sharing` char(1) DEFAULT NULL,
  `pass_through` char(1) DEFAULT NULL,
  `cred_calc_aliq` decimal(10,2) DEFAULT NULL,
  `cred_expl_value` decimal(10,6) DEFAULT NULL,
  `freight_value` decimal(10,2) DEFAULT NULL,
  `insurance_Value` decimal(10,2) DEFAULT NULL,
  `expenses_value` decimal(10,2) DEFAULT NULL,
  `tb_cfop_id` varchar(10) DEFAULT NULL,
  `approximate_tax` decimal(10,2) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`,`tb_order_item_id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_icms_fcp` (
  `tb_order_id` int(11) DEFAULT NULL,
  `tb_order_item_id` int(11) DEFAULT NULL,
  `tb_institution_id` int(11) DEFAULT NULL,
  `terminal` int(11) DEFAULT NULL,
  `vbcfcp` decimal(13,2) DEFAULT NULL,
  `pfcp` decimal(10,4) DEFAULT NULL,
  `vfcp` decimal(13,2) DEFAULT NULL,
  `vbcfcpst` decimal(13,2) DEFAULT NULL,
  `pfcpst` decimal(10,4) DEFAULT NULL,
  `vfcpst` decimal(13,2) DEFAULT NULL,
  `pst` decimal(10,4) DEFAULT NULL,
  `vbcfcpstret` decimal(13,2) DEFAULT NULL,
  `pfcpstret` decimal(10,4) DEFAULT NULL,
  `vfcpstret` decimal(13,2) DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_ii` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_order_item_id` int(11) NOT NULL,
  `base_value` decimal(10,2) DEFAULT NULL,
  `customs_expense` decimal(10,2) DEFAULT NULL,
  `tag_value` decimal(10,2) DEFAULT NULL,
  `iof_value` decimal(10,2) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_order_id`,`terminal`,`tb_order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_ipi` (
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `cst` varchar(2) DEFAULT NULL,
  `class_frame` varchar(5) DEFAULT NULL,
  `producer_cnpj` varchar(14) DEFAULT NULL,
  `stamp_ctrl` varchar(60) DEFAULT NULL,
  `stamp_qtty` decimal(10,2) DEFAULT NULL,
  `class_frame_code` varchar(3) DEFAULT NULL,
  `base_value` decimal(15,2) DEFAULT NULL,
  `aliq_value` decimal(5,2) DEFAULT NULL,
  `unit_qtty` decimal(16,4) DEFAULT NULL,
  `unit_value` decimal(15,4) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`,`tb_order_item_id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_ipi_back` (
  `tb_order_id` int(11) DEFAULT NULL,
  `tb_order_item_id` int(11) DEFAULT NULL,
  `tb_institution_id` int(11) DEFAULT NULL,
  `terminal` int(11) DEFAULT NULL,
  `p_ipi` decimal(13,2) DEFAULT NULL,
  `v_ipi` decimal(10,4) DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_issqn` (
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `base_value` decimal(10,2) DEFAULT NULL,
  `aliq_value` decimal(10,2) DEFAULT NULL,
  `tag_value` decimal(10,2) DEFAULT NULL,
  `listservice` varchar(50) DEFAULT NULL,
  `tax_code` varchar(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`,`tb_order_item_id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_job` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `work_front` varchar(50) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item_pis` (
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `cst` varchar(2) DEFAULT NULL,
  `base_value` decimal(10,2) DEFAULT NULL,
  `aliq_value` decimal(10,2) DEFAULT NULL,
  `qt_sale_qtty` decimal(16,4) DEFAULT NULL,
  `qt_aliq_value` decimal(15,4) DEFAULT NULL,
  `tag_value` decimal(15,4) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`,`tb_order_item_id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_job` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `number` int(11) DEFAULT NULL,
  `description` varchar(100) DEFAULT NULL,
  `tb_customer_id` int(11) NOT NULL,
  `dt_start` date DEFAULT NULL,
  `dt_forecast` date DEFAULT NULL,
  `dt_end` date DEFAULT NULL,
  `cost_value` decimal(10,6) DEFAULT NULL,
  `tb_situation_id` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_customer_id` (`tb_customer_id`),
  KEY `tb_institution_id` (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_job_scope` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `tb_work_front_id` int(11) NOT NULL,
  `note` blob DEFAULT NULL,
  `dt_forecast` date DEFAULT NULL,
  `value_forecast` decimal(10,6) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_packing` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `number` int(11) DEFAULT NULL,
  `tb_entity_id` int(11) NOT NULL,
  `tb_situation_id` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_entity_id` (`tb_entity_id`),
  KEY `tb_situation_id` (`tb_situation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_production` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `number` int(11) DEFAULT NULL,
  `dt_start` date DEFAULT NULL,
  `dt_end` date DEFAULT NULL,
  `tb_merchandise_id` int(11) NOT NULL,
  `tb_situation_id` int(11) NOT NULL,
  `qtty_forecast` decimal(10,3) DEFAULT NULL,
  `tb_stock_list_id_ori` int(11) NOT NULL,
  `tb_stock_list_id_des` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_production_mp` (
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `id` int(11) NOT NULL,
  `tb_product_id` int(11) NOT NULL,
  `tb_stock_list_id` int(11) NOT NULL,
  `kind` char(1) DEFAULT NULL,
  `quantity` decimal(10,4) DEFAULT NULL,
  `unit_value` decimal(10,6) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`terminal`,`tb_institution_id`,`tb_order_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_production_pa` (
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `id` int(11) NOT NULL,
  `tb_product_id` int(11) NOT NULL,
  `tb_stock_list_id` int(11) NOT NULL,
  `quantity` decimal(10,4) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`terminal`,`tb_institution_id`,`tb_order_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_shipping` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_carrier_id` int(11) NOT NULL,
  `kind` varchar(45) DEFAULT NULL,
  `tb_freight_mode_id` char(1) DEFAULT NULL,
  `tb_address_id` int(11) DEFAULT NULL,
  `help_reference` varchar(100) DEFAULT 'NULL',
  `delivery_date` datetime DEFAULT NULL,
  `value` decimal(10,6) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`),
  KEY `tb_institution_id` (`tb_institution_id`),
  KEY `tb_carrier_id` (`tb_carrier_id`),
  CONSTRAINT `tb_order_shipping_ibfk_3` FOREIGN KEY (`tb_carrier_id`) REFERENCES `tb_carrier` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_stock_adjust` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_entity_id` int(11) NOT NULL,
  `number` int(11) DEFAULT NULL,
  `direction` varchar(1) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_stock_transfer` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_entity_id` int(11) NOT NULL,
  `number` int(11) DEFAULT NULL,
  `tb_stock_list_id_ori` int(11) NOT NULL,
  `tb_stock_list_id_des` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_to_buy` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_product_id` int(11) NOT NULL,
  `dt_record` date NOT NULL,
  `quantity` decimal(10,4) NOT NULL,
  `status` char(1) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`tb_order_item_id`),
  KEY `tb_order_item_id` (`tb_order_item_id`),
  KEY `tb_order_id` (`tb_order_id`),
  KEY `tb_order_to_buy_ibfk_1` (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_to_deliver` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_product_id` int(11) NOT NULL,
  `tb_stock_list_id` int(11) NOT NULL,
  `dt_record` date NOT NULL,
  `quantity` decimal(10,4) NOT NULL,
  `refer_doc` varchar(25) NOT NULL,
  `status` char(1) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`tb_order_item_id`),
  KEY `tb_order_item_id` (`tb_order_item_id`),
  KEY `tb_order_id` (`tb_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_to_production` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_product_id` int(11) NOT NULL,
  `dt_record` date NOT NULL,
  `quantity` decimal(10,4) NOT NULL,
  `status` char(1) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`tb_order_item_id`),
  KEY `tb_order_to_production_ibfk_1` (`tb_institution_id`),
  KEY `tb_order_to_production_ibfk_2` (`tb_order_id`),
  KEY `tb_order_to_production_ibfk_3` (`tb_order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_has_production` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_order_item_id` int(11) NOT NULL,
  `tb_order_production_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_order_id`,`tb_order_item_id`),
  KEY `tb_order_has_production_ibfk_2` (`tb_order_id`),
  KEY `tb_order_has_production_ibfk_3` (`tb_order_item_id`),
  CONSTRAINT `tb_order_has_production_ibfk_1` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_order_to_production` (`tb_institution_id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_order_has_production_ibfk_2` FOREIGN KEY (`tb_order_id`) REFERENCES `tb_order_to_production` (`tb_order_id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_order_has_production_ibfk_3` FOREIGN KEY (`tb_order_item_id`) REFERENCES `tb_order_to_production` (`tb_order_item_id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_package` (
  `id` int(11) NOT NULL,
  `description` varchar(100) NOT NULL,
  `abbreviation` varchar(3) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_package` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_package_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_package_id`),
  KEY `tb_package_id` (`tb_package_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `tb_institution_has_package_ibfk_1` FOREIGN KEY (`tb_package_id`) REFERENCES `tb_package` (`id`),
  CONSTRAINT `tb_institution_has_package_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_partnership` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `description` varchar(50) DEFAULT NULL,
  `dt_record` date DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_partnership_customer` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_customer` int(11) NOT NULL,
  `tb_partnership_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_partnership_partner` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_partnership_id` int(11) NOT NULL,
  `tb_collaborator_id` int(11) NOT NULL,
  `rate` decimal(10,2) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_payment_types` (
  `id` int(11) NOT NULL,
  `description` varchar(45) DEFAULT NULL,
  `id_nfce` varchar(2) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_payment_types` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_payment_types_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `app_delivery` char(1) DEFAULT 'N',
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_payment_types_id`),
  KEY `tb_payment_types_id` (`tb_payment_types_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `tb_institution_has_payment_types_ibfk_1` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`),
  CONSTRAINT `tb_institution_has_payment_types_ibfk_2` FOREIGN KEY (`tb_payment_types_id`) REFERENCES `tb_payment_types` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_person` (
  `id` int(11) NOT NULL,
  `cpf` char(11) NOT NULL,
  `rg` char(20) DEFAULT NULL,
  `rg_dt_emission` date DEFAULT NULL,
  `rg_organ_issuer` varchar(45) DEFAULT NULL,
  `rg_state_issuer` int(11) DEFAULT NULL,
  `birthday` date DEFAULT NULL,
  `tb_profession_id` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  UNIQUE KEY `cpf` (`cpf`),
  CONSTRAINT `tb_person_ibfk_1` FOREIGN KEY (`id`) REFERENCES `tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_phone` (
  `id` int(11) NOT NULL DEFAULT 0,
  `kind` varchar(20) NOT NULL,
  `contact` varchar(100) DEFAULT NULL,
  `number` varchar(20) DEFAULT NULL,
  `address_kind` varchar(100) DEFAULT '',
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`kind`),
  KEY `id` (`id`,`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_price_list` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `description` varchar(45) NOT NULL,
  `validity` date DEFAULT NULL,
  `modality` varchar(1) DEFAULT NULL,
  `aliq_profit` decimal(10,0) DEFAULT NULL,
  `published` char(1) DEFAULT 'S',
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_priority` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `description` varchar(50) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_privilege` (
  `id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_interface_has_privilege` (
  `tb_interface_id` int(11) NOT NULL,
  `tb_privilege_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_interface_id`,`tb_privilege_id`),
  KEY `tb_privilege_id` (`tb_privilege_id`),
  CONSTRAINT `tb_interface_has_privilege_ibfk_1` FOREIGN KEY (`tb_interface_id`) REFERENCES `tb_interface` (`id`),
  CONSTRAINT `tb_interface_has_privilege_ibfk_2` FOREIGN KEY (`tb_privilege_id`) REFERENCES `tb_privilege` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_product` (
  `id` int(11) NOT NULL DEFAULT 0,
  `identifier` varchar(50) NOT NULL DEFAULT '0',
  `tb_institution_id` int(11) NOT NULL DEFAULT 0,
  `description` varchar(100) NOT NULL DEFAULT '0',
  `tb_category_id` int(11) NOT NULL DEFAULT 0,
  `tb_financial_plans_id` int(11) DEFAULT NULL,
  `promotion` char(1) DEFAULT NULL,
  `highlights` char(1) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `published` char(1) DEFAULT NULL,
  `note` blob DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_category_id` (`tb_category_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  KEY `tb_product_ibfk_1` (`tb_category_id`,`tb_institution_id`),
  KEY `active` (`active`),
  KEY `description` (`description`),
  KEY `published` (`published`),
  CONSTRAINT `tb_product_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_price` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_price_list_id` int(11) NOT NULL,
  `tb_product_id` int(11) NOT NULL,
  `price_tag` decimal(13,6) DEFAULT NULL,
  `aliq_profit` decimal(10,3) DEFAULT NULL,
  `aliq_kickback` decimal(10,2) DEFAULT NULL,
  `quantity` decimal(10,3) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_price_list_id`,`tb_product_id`),
  KEY `tb_institution_id` (`tb_institution_id`,`tb_product_id`),
  KEY `updated_at` (`updated_at`),
  KEY `tb_price_ibfk_2` (`tb_price_list_id`),
  CONSTRAINT `tb_price_ibfk_1` FOREIGN KEY (`tb_institution_id`, `tb_product_id`) REFERENCES `tb_product` (`tb_institution_id`, `id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT `tb_price_ibfk_2` FOREIGN KEY (`tb_price_list_id`) REFERENCES `tb_price_list` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_merchandise` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `id_internal` varchar(45) DEFAULT NULL,
  `id_provider` int(11) DEFAULT NULL,
  `ncm` varchar(8) DEFAULT NULL,
  `cest` varchar(7) DEFAULT NULL,
  `kind_tributary` char(1) DEFAULT NULL,
  `source` char(1) DEFAULT NULL,
  `kind` varchar(45) DEFAULT NULL,
  `tb_brand_id` int(11) NOT NULL,
  `print` char(1) DEFAULT NULL,
  `controlseries` varchar(1) DEFAULT NULL,
  `exclusive_dealer` char(1) DEFAULT NULL,
  `application` blob DEFAULT NULL,
  `composition` char(1) DEFAULT NULL,
  `manuf_sign_ind_scale` char(1) DEFAULT 'S',
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_brand_id` (`tb_brand_id`),
  KEY `kind` (`kind`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_merchandise_1` FOREIGN KEY (`id`, `tb_institution_id`) REFERENCES `tb_product` (`id`, `tb_institution_id`),
  CONSTRAINT `tb_merchandise_ibfk_1` FOREIGN KEY (`id`, `tb_institution_id`) REFERENCES `tb_product` (`id`, `tb_institution_id`) ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_product_uf_benef` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_product_id` int(11) NOT NULL,
  `uf` char(2) NOT NULL,
  `cst` char(3) DEFAULT NULL,
  `cod_benefits` varchar(50) DEFAULT NULL,
  `updated_at` datetime DEFAULT current_timestamp(),
  `created_at` datetime DEFAULT current_timestamp(),
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_product_id`,`uf`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_progress` (
  `tb_iteration_id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_performer_id` int(11) NOT NULL,
  `dt_initi` datetime DEFAULT NULL,
  `dt_final` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_proj_log_changes` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_project_id` int(11) NOT NULL,
  `id` int(11) NOT NULL,
  `dt_record` date DEFAULT NULL,
  `desc_interface` varchar(100) DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_project_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_project` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `number` int(11) NOT NULL,
  `dt_record` date DEFAULT NULL,
  `tb_entity_id` int(11) NOT NULL,
  `tb_situation_id` int(11) NOT NULL,
  `description` varchar(50) DEFAULT NULL,
  `detail` blob DEFAULT NULL,
  `dt_initi_forecast` date DEFAULT NULL,
  `dt_final_forecast` date DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_promotion` (
  `tb_institution_id` int(11) NOT NULL,
  `id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `price_tag` decimal(10,6) DEFAULT NULL,
  `quantity` decimal(10,3) DEFAULT NULL,
  `reg_active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `oper` char(1) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`id`),
  KEY `updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_promotion_items` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_promotion_id` int(11) NOT NULL,
  `tb_product_id` int(11) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `oper` char(1) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_promotion_id`,`tb_product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_proposal` (
  `tb_iteration_id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `forecast_time` time DEFAULT NULL,
  `tag_value` decimal(10,2) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_iteration_id`,`tb_institution_id`,`tb_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_provider` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `active` char(1) NOT NULL DEFAULT 'N',
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_institution_id` (`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_purchase` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `number` int(11) DEFAULT NULL,
  `tb_provider_id` int(11) NOT NULL,
  `approved` char(1) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`),
  KEY `tb_provider_id` (`tb_provider_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  CONSTRAINT `tb_order_purchase_ibfk_1` FOREIGN KEY (`tb_provider_id`) REFERENCES `tb_provider` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_provisional_receipt_service` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL,
  `dt_record` date DEFAULT NULL,
  `number` int(11) NOT NULL DEFAULT 0,
  `nr_lot` int(11) DEFAULT NULL,
  `protocol` varchar(50) DEFAULT NULL,
  `note` blob DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_salesman` (
  `id` int(11) NOT NULL DEFAULT 0,
  `tb_institution_id` int(11) NOT NULL DEFAULT 0,
  `active` char(1) NOT NULL DEFAULT 'N',
  `aliq_kickback` decimal(10,2) DEFAULT NULL,
  `kickback_product` varchar(1) DEFAULT NULL,
  `flex_value` decimal(10,2) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  CONSTRAINT `tb_salesman_ibfk_1` FOREIGN KEY (`id`) REFERENCES `tb_entity` (`id`),
  CONSTRAINT `tb_salesman_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_salesman_has_state` (
  `tb_institution_id` int(11) NOT NULL DEFAULT 0,
  `tb_salesman_id` int(11) NOT NULL DEFAULT 0,
  `tb_state_id` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_salesman_id`,`tb_state_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_salesman_has_stock` (
  `tb_institution_id` int(11) NOT NULL DEFAULT 0,
  `tb_salesman_id` int(11) NOT NULL DEFAULT 0,
  `tb_stock_id` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_salesman_id`,`tb_stock_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_situation` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `modulo` varchar(50) NOT NULL,
  `flag_01` char(1) DEFAULT NULL,
  `flag_02` char(1) DEFAULT NULL,
  `flag_03` char(1) DEFAULT NULL,
  `flag_04` char(1) DEFAULT NULL,
  `active` varchar(1) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_social_media` (
  `id` int(11) NOT NULL,
  `kind` varchar(50) NOT NULL,
  `link` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`kind`),
  CONSTRAINT `fk_social_media_to_entity` FOREIGN KEY (`id`) REFERENCES `tb_entity` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_state` (
  `id` int(11) NOT NULL,
  `tb_country_id` int(11) NOT NULL,
  `abbreviation` varchar(2) DEFAULT NULL,
  `name` varchar(100) DEFAULT NULL,
  `aliquota` decimal(10,2) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `fk_state_to_country` (`tb_country_id`),
  CONSTRAINT `fk_state_to_country` FOREIGN KEY (`tb_country_id`) REFERENCES `tb_country` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_city` (
  `id` int(11) NOT NULL,
  `tb_state_id` int(11) NOT NULL,
  `ibge` varchar(20) DEFAULT NULL,
  `name` varchar(100) DEFAULT NULL,
  `aliq_iss` decimal(10,2) NOT NULL DEFAULT 0.00,
  `population` int(11) DEFAULT 0,
  `density` decimal(10,2) DEFAULT 0.00,
  `area` decimal(10,2) DEFAULT 0.00,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `fk_city_to_state` (`tb_state_id`),
  CONSTRAINT `fk_city_to_state` FOREIGN KEY (`tb_state_id`) REFERENCES `tb_state` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_address` (
  `id` int(11) NOT NULL,
  `street` varchar(100) NOT NULL DEFAULT 'não informado',
  `nmbr` varchar(10) DEFAULT 'sn',
  `complement` varchar(100) DEFAULT NULL,
  `neighborhood` varchar(100) DEFAULT NULL,
  `region` varchar(100) DEFAULT NULL,
  `kind` varchar(100) NOT NULL DEFAULT '',
  `zip_code` varchar(15) DEFAULT NULL,
  `tb_country_id` int(11) NOT NULL,
  `tb_state_id` int(11) NOT NULL,
  `tb_city_id` int(11) NOT NULL,
  `main` char(1) NOT NULL DEFAULT 'Y',
  `longitude` varchar(20) DEFAULT NULL,
  `latitude` varchar(20) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`kind`),
  KEY `fk_country_to_address` (`tb_country_id`),
  KEY `fk_state_to_address` (`tb_state_id`),
  KEY `fk_city_to_address` (`tb_city_id`),
  CONSTRAINT `fk_city_to_address` FOREIGN KEY (`tb_city_id`) REFERENCES `tb_city` (`id`),
  CONSTRAINT `fk_country_to_address` FOREIGN KEY (`tb_country_id`) REFERENCES `tb_country` (`id`),
  CONSTRAINT `fk_state_to_address` FOREIGN KEY (`tb_state_id`) REFERENCES `tb_state` (`id`),
  CONSTRAINT `tb_address_ibfk_1` FOREIGN KEY (`id`) REFERENCES `tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_state_fcp_ncm` (
  `tb_state_id` int(11) NOT NULL,
  `ncm` varchar(8) NOT NULL,
  `aliquota` decimal(10,2) DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_state_id`,`ncm`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_state_mva_ncm` (
  `tb_state_id` int(11) NOT NULL,
  `ncm` varchar(8) NOT NULL,
  `mva` decimal(10,4) DEFAULT NULL,
  `aliquota` decimal(10,2) DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_state_id`,`ncm`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_stock` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_merchandise_id` int(11) NOT NULL DEFAULT 0,
  `tb_package_id` int(11) NOT NULL,
  `tb_measure_id` int(11) DEFAULT NULL,
  `tb_color_id` int(11) DEFAULT NULL,
  `codebar` varchar(20) DEFAULT NULL,
  `st` char(1) NOT NULL DEFAULT 'N',
  `quantity` decimal(10,4) DEFAULT NULL,
  `minimum` decimal(10,4) DEFAULT NULL,
  `divisor` int(11) DEFAULT NULL,
  `location` varchar(100) DEFAULT NULL,
  `weight` decimal(10,4) DEFAULT NULL,
  `width` decimal(10,4) DEFAULT NULL,
  `length` decimal(10,4) DEFAULT NULL,
  `height` decimal(10,4) DEFAULT NULL,
  `cost_manufactures` decimal(10,4) DEFAULT NULL,
  `actual_cost` decimal(10,4) DEFAULT NULL,
  `cost_price` decimal(10,4) DEFAULT NULL,
  `negative` char(1) DEFAULT NULL,
  `outline` char(1) DEFAULT NULL,
  `link_url` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_merchandise_id`),
  KEY `codebar` (`codebar`),
  KEY `updated_at` (`updated_at`),
  KEY `fk_stock_1` (`tb_merchandise_id`,`tb_institution_id`),
  KEY `fk_stock_2` (`tb_measure_id`),
  CONSTRAINT `fk_stock_1` FOREIGN KEY (`tb_merchandise_id`, `tb_institution_id`) REFERENCES `tb_merchandise` (`id`, `tb_institution_id`),
  CONSTRAINT `fk_stock_2` FOREIGN KEY (`tb_measure_id`) REFERENCES `tb_measure` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_stock_balance` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_stock_list_id` int(11) NOT NULL,
  `tb_merchandise_id` int(11) NOT NULL,
  `quantity` decimal(10,4) DEFAULT NULL,
  `minimum` decimal(10,4) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_stock_list_id`,`tb_merchandise_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_stock_list` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `description` varchar(45) DEFAULT NULL,
  `main` char(1) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `kind` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `terminal` int(11) DEFAULT 0,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_stock_reserved` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_stock_list_id` int(11) NOT NULL,
  `tb_merchandise_id` int(11) NOT NULL,
  `dt_record` date NOT NULL,
  `quantity` decimal(10,6) NOT NULL,
  `status` char(1) NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_stock_list_id`),
  KEY `tb_stock_list_id` (`tb_stock_list_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  CONSTRAINT `tb_stock_reserved_ibfk_1` FOREIGN KEY (`tb_stock_list_id`) REFERENCES `tb_stock_list` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_stock_reserved_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_stock_statement` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tb_institution_id` int(11) NOT NULL DEFAULT 0,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_order_id` int(11) NOT NULL DEFAULT 0,
  `tb_order_item_id` int(11) NOT NULL DEFAULT 0,
  `tb_stock_list_id` int(11) NOT NULL DEFAULT 0,
  `local` varchar(25) DEFAULT NULL,
  `kind` varchar(25) DEFAULT NULL,
  `dt_record` date DEFAULT NULL,
  `direction` varchar(1) DEFAULT NULL,
  `tb_merchandise_id` int(11) DEFAULT NULL,
  `quantity` decimal(10,4) DEFAULT NULL,
  `operation` varchar(50) DEFAULT NULL,
  `note` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `tb_institution_id` (`tb_institution_id`,`terminal`,`tb_order_id`,`tb_order_item_id`,`tb_stock_list_id`,`direction`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_task` (
  `tb_iteration_id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_project_id` int(11) NOT NULL,
  `tb_performer_id` int(11) NOT NULL,
  `dt_initi` datetime DEFAULT NULL,
  `dt_final` datetime DEFAULT NULL,
  `tb_priority_id` int(11) DEFAULT NULL,
  `tb_kind_id` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_iteration_id`,`tb_institution_id`,`tb_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_tax_cofins` (
  `id` char(2) NOT NULL DEFAULT '',
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_tax_icms_nr` (
  `id` char(2) NOT NULL DEFAULT '',
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_tax_icms_sn` (
  `id` char(3) NOT NULL DEFAULT '',
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_tax_ipi` (
  `id` char(2) NOT NULL DEFAULT '',
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_tax_pis` (
  `id` char(2) NOT NULL DEFAULT '',
  `description` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_tax_ruler` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_product_id` int(11) NOT NULL,
  `origem` char(1) DEFAULT NULL,
  `tb_tax_icms_nr_id` char(2) NOT NULL,
  `tb_tax_icms_sn_id` char(3) NOT NULL,
  `tb_deter_base_tax_icms_id` char(2) DEFAULT NULL,
  `tb_deter_base_tax_icms_st_id` char(2) DEFAULT NULL,
  `tb_discharge_icms_id` int(11) DEFAULT NULL,
  `icms_aliq` decimal(10,2) DEFAULT NULL,
  `icms_aliq_reduced` decimal(10,2) DEFAULT NULL,
  `icms_base_reduced` decimal(10,2) DEFAULT NULL,
  `tb_tax_ipi_id` char(2) DEFAULT NULL,
  `ipi_aliq` decimal(10,2) DEFAULT NULL,
  `tb_tax_pis_id` char(2) DEFAULT NULL,
  `pis_aliq` decimal(10,2) DEFAULT NULL,
  `tb_tax_cofins_id` char(2) DEFAULT NULL,
  `cofins_aliq` decimal(10,2) DEFAULT NULL,
  `irrj_aliq` decimal(10,2) DEFAULT NULL,
  `csll_aqli` decimal(10,2) DEFAULT NULL,
  `ii_aliq` decimal(10,2) DEFAULT NULL,
  `for_icms_st` char(1) DEFAULT NULL,
  `for_consumer` char(1) DEFAULT NULL,
  `crt` varchar(3) DEFAULT NULL,
  `tb_observation_id` int(11) DEFAULT NULL,
  `tb_cfop_id` varchar(10) DEFAULT NULL,
  `tb_state_id` int(11) DEFAULT NULL,
  `tax_substitute` varchar(1) DEFAULT NULL,
  `transaction_kind` char(1) DEFAULT NULL,
  `afrmm_aliq` decimal(10,5) DEFAULT NULL,
  `siscomex_aliq` decimal(10,5) DEFAULT NULL,
  `ncm` varchar(8) DEFAULT NULL,
  `propag_base_reduc` char(1) DEFAULT NULL,
  `direction` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_product_id`),
  KEY `tb_tax_icms_nr_id` (`tb_tax_icms_nr_id`),
  KEY `tb_tax_icms_sn_id` (`tb_tax_icms_sn_id`),
  KEY `tb_deter_base_tax_icms_id` (`tb_deter_base_tax_icms_id`),
  KEY `tb_deter_base_tax_icms_st_id` (`tb_deter_base_tax_icms_st_id`),
  KEY `tb_discharge_icms_id` (`tb_discharge_icms_id`),
  KEY `tb_tax_ipi_id` (`tb_tax_ipi_id`),
  KEY `tb_tax_cofins_id` (`tb_tax_cofins_id`),
  KEY `tb_tax_pis_id` (`tb_tax_pis_id`),
  KEY `tb_cfop_id` (`tb_cfop_id`),
  KEY `tb_state_id` (`tb_state_id`),
  KEY `tb_tax_ruler_ibfk_1` (`tb_institution_id`),
  CONSTRAINT `tb_tax_ruler_ibfk_1` FOREIGN KEY (`tb_discharge_icms_id`) REFERENCES `tb_discharge_icms` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_tax_ruler_ibfk_10` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_tax_ruler_ibfk_11` FOREIGN KEY (`tb_tax_pis_id`) REFERENCES `tb_tax_pis` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_tax_ruler_ibfk_3` FOREIGN KEY (`tb_tax_icms_sn_id`) REFERENCES `tb_tax_icms_sn` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_tax_ruler_ibfk_4` FOREIGN KEY (`tb_deter_base_tax_icms_st_id`) REFERENCES `tb_deter_base_tax_icms_st` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_tax_ruler_ibfk_5` FOREIGN KEY (`tb_deter_base_tax_icms_id`) REFERENCES `tb_deter_base_tax_icms` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_tax_ruler_ibfk_6` FOREIGN KEY (`tb_cfop_id`) REFERENCES `tb_cfop` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_tax_ruler_ibfk_7` FOREIGN KEY (`tb_state_id`) REFERENCES `tb_state` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_tax_ruler_ibfk_8` FOREIGN KEY (`tb_tax_icms_nr_id`) REFERENCES `tb_tax_icms_nr` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `tb_tax_ruler_ibfk_9` FOREIGN KEY (`tb_tax_ipi_id`) REFERENCES `tb_tax_ipi` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_user` (
  `id` int(11) NOT NULL,
  `password` varchar(100) DEFAULT NULL,
  `kind` varchar(20) NOT NULL DEFAULT 'sistema',
  `salt` varchar(255) DEFAULT NULL,
  `tb_device_id` int(11) NOT NULL DEFAULT 0,
  `active` char(1) NOT NULL DEFAULT 'S',
  `activation_key` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`kind`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `fk_user_to_entity` FOREIGN KEY (`id`) REFERENCES `tb_entity` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_user_id` int(11) NOT NULL,
  `dt_record` date DEFAULT NULL,
  `note` blob DEFAULT NULL,
  `origin` char(1) DEFAULT NULL,
  `status` varchar(1) DEFAULT NULL,
  `being_used` varchar(50) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `obj_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`),
  KEY `tb_user_id` (`tb_user_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  KEY `status` (`status`),
  CONSTRAINT `tb_order_ibfk_1` FOREIGN KEY (`tb_user_id`) REFERENCES `tb_user` (`id`),
  CONSTRAINT `tb_order_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_shipping` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `tb_haulier_id` int(11) NOT NULL,
  `kind` varchar(45) DEFAULT NULL,
  `accountable` int(11) DEFAULT NULL,
  `value` decimal(10,6) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`),
  KEY `tb_order_id` (`tb_order_id`),
  KEY `tb_haulier_id` (`tb_haulier_id`),
  CONSTRAINT `tb_shipping_ibfk_1` FOREIGN KEY (`tb_order_id`) REFERENCES `tb_order` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_totalizer` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `items_qtde` int(11) NOT NULL,
  `product_qtde` decimal(10,3) DEFAULT NULL,
  `product_value` decimal(10,3) DEFAULT NULL,
  `IPI_value` decimal(10,3) DEFAULT NULL,
  `discount_aliquot` decimal(10,3) DEFAULT NULL,
  `discount_value` decimal(10,2) DEFAULT NULL,
  `expenses_value` decimal(10,2) DEFAULT NULL,
  `total_value` decimal(10,2) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`),
  KEY `tb_institution_id` (`tb_institution_id`),
  CONSTRAINT `fk_order_totalilzer_1` FOREIGN KEY (`id`, `tb_institution_id`, `terminal`) REFERENCES `tb_order` (`id`, `tb_institution_id`, `terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_sale` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_salesman_id` int(11) NOT NULL,
  `number` int(11) DEFAULT NULL,
  `tb_customer_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`,`tb_salesman_id`),
  KEY `tb_customer_id` (`tb_customer_id`),
  KEY `tb_salesman_id` (`tb_salesman_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  KEY `number` (`number`),
  CONSTRAINT `fk_order_sale_order_1` FOREIGN KEY (`id`, `tb_institution_id`, `terminal`) REFERENCES `tb_order` (`id`, `tb_institution_id`, `terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_item` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `tb_order_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `kind` varchar(50) NOT NULL DEFAULT 'Sale',
  `tb_product_id` int(11) NOT NULL,
  `tb_stock_list_id` int(11) NOT NULL,
  `quantity` decimal(10,4) DEFAULT NULL,
  `unit_value` decimal(10,6) DEFAULT NULL,
  `discount_aliquot` decimal(10,2) DEFAULT NULL,
  `discount_value` decimal(10,6) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `tb_price_list_id` int(11) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_order_id`,`terminal`,`kind`),
  KEY `tb_product_id` (`tb_product_id`),
  KEY `tb_stock_list_id` (`tb_stock_list_id`),
  KEY `fk_order_item_1` (`tb_order_id`,`tb_institution_id`,`terminal`),
  CONSTRAINT `fk_order_item_1` FOREIGN KEY (`tb_order_id`, `tb_institution_id`, `terminal`) REFERENCES `tb_order` (`id`, `tb_institution_id`, `terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_order_billing` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `terminal` int(11) NOT NULL DEFAULT 0,
  `tb_payment_types_id` int(11) NOT NULL,
  `plots` varchar(3) DEFAULT NULL,
  `deadline` varchar(255) DEFAULT NULL,
  `task_owner` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`terminal`),
  KEY `tb_payment_types_id` (`tb_payment_types_id`),
  CONSTRAINT `fk_order_billing_1` FOREIGN KEY (`id`, `tb_institution_id`, `terminal`) REFERENCES `tb_order` (`id`, `tb_institution_id`, `terminal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_institution_has_user` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_user_id` int(11) NOT NULL,
  `kind` varchar(20) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_user_id`,`tb_institution_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  KEY `updated_at` (`updated_at`),
  CONSTRAINT `tb_institution_has_user_ibfk_1` FOREIGN KEY (`tb_user_id`) REFERENCES `tb_user` (`id`),
  CONSTRAINT `tb_institution_has_user_ibfk_2` FOREIGN KEY (`tb_institution_id`) REFERENCES `tb_institution` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_user_has_privilege` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_user_id` int(11) NOT NULL,
  `tb_interface_id` int(11) NOT NULL,
  `tb_privilege_id` int(11) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_user_id`,`tb_interface_id`,`tb_privilege_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_user_send_email` (
  `tb_user_id` int(11) NOT NULL,
  `smtp` varchar(100) DEFAULT NULL,
  `port` varchar(10) DEFAULT NULL,
  `pass_word` varchar(100) DEFAULT NULL,
  `req_auth` char(1) DEFAULT NULL,
  `req_ssl` char(1) DEFAULT NULL,
  `notify_access` char(1) DEFAULT NULL,
  `signature` blob DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_user_id`),
  CONSTRAINT `tb_user_send_email_ibfk_1` FOREIGN KEY (`tb_user_id`) REFERENCES `tb_user` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_whatsapp` (
  `tb_institution_id` int(11) NOT NULL,
  `id` varchar(20) NOT NULL,
  `session_id` varchar(50) DEFAULT NULL,
  `url_api` varchar(100) NOT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_whatsapp_auto_answer` (
  `tb_institution_id` int(11) NOT NULL,
  `id` int(11) NOT NULL,
  `description` varchar(50) NOT NULL,
  `message` varchar(100) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_whatsapp_has_contact` (
  `tb_institution_id` int(11) NOT NULL,
  `tb_whatsapp_id` varchar(20) NOT NULL,
  `id` varchar(20) NOT NULL,
  `name` varchar(100) DEFAULT NULL,
  `img_full_url` varchar(512) DEFAULT NULL,
  `active` char(1) DEFAULT 'S',
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp(),
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`,`tb_whatsapp_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_whatsapp_has_talk` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tb_institution_id` int(11) NOT NULL,
  `tb_whatsapp_id` varchar(20) NOT NULL,
  `contact_id` varchar(20) NOT NULL,
  `body_text` blob DEFAULT NULL,
  `type_way` varchar(8) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp(),
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`,`tb_whatsapp_id`,`contact_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tb_work_front` (
  `id` int(11) NOT NULL,
  `tb_institution_id` int(11) NOT NULL,
  `description` varchar(100) DEFAULT NULL,
  `active` char(1) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`,`tb_institution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `tutorial` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `title` varchar(100) NOT NULL DEFAULT '0',
  `description` varchar(255) DEFAULT NULL,
  `published` char(1) DEFAULT NULL,
  `deleted` char(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Tabela de auditoria do sistema (padrao Setes)
CREATE TABLE IF NOT EXISTS `tb_audit_log` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `tb_user_id` INT(11) DEFAULT NULL,
  `tb_institution_id` INT(11) DEFAULT NULL,
  `action` VARCHAR(255) NOT NULL,
  `entity` VARCHAR(100) DEFAULT NULL,
  `entity_id` VARCHAR(36) DEFAULT NULL,
  `payload` JSON DEFAULT NULL,
  `ip_address` VARCHAR(45) DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `tb_user_id` (`tb_user_id`),
  KEY `tb_institution_id` (`tb_institution_id`),
  KEY `entity` (`entity`),
  KEY `created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


SET FOREIGN_KEY_CHECKS = 1;
