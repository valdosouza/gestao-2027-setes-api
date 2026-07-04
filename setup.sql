CREATE DATABASE IF NOT EXISTS setes_central;
USE setes_central;

CREATE TABLE IF NOT EXISTS tenants (
  id          VARCHAR(36)  PRIMARY KEY DEFAULT (UUID()),
  name        VARCHAR(255) NOT NULL,
  schema_name VARCHAR(100) NOT NULL UNIQUE,
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS feature_flags (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id  VARCHAR(36)  NOT NULL,
  module_key VARCHAR(100) NOT NULL,
  enabled    BOOLEAN      NOT NULL DEFAULT FALSE,
  UNIQUE KEY uq_tenant_module (tenant_id, module_key)
);

-- Dados de teste
INSERT INTO tenants (id, name, schema_name) VALUES
  ('tenant-001', 'Empresa Alpha', 'setes_alpha'),
  ('tenant-002', 'Empresa Beta',  'setes_beta');

-- Alpha tem ERP habilitado, Beta não
INSERT INTO feature_flags (tenant_id, module_key, enabled) VALUES
  ('tenant-001', 'core', TRUE),
  ('tenant-001', 'erp',  TRUE),
  ('tenant-002', 'core', TRUE),
  ('tenant-002', 'erp',  FALSE);
