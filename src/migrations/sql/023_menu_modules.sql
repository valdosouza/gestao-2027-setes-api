-- =============================================================
-- Migration: 023_menu_modules.sql
-- Módulo de Menus do cliente (prompt_modulo_menus.md, D3/D4 —
-- Valdo 2026-08-04): a camada 2 do menu ganha CRUD e ORDEM.
--   - tb_module.position: ordem do módulo no menu vertical
--   - tb_module.link_name DROPADA (legado nunca lido — D4)
--   - tb_module.image_icon INT → VARCHAR(50): nome de ícone
--     Material renderizado pelo app (D4; regra "sem legado")
--   - tb_module_has_interface.position: a ordem do array do PUT
--     é a ordem das telas no menu (D3)
-- Tabelas nasceram vazias na prática (camada era só-leitura sem
-- tela de escrita) — conversões de dado são triviais.
-- =============================================================

ALTER TABLE `tb_module`
  ADD COLUMN `position` INT DEFAULT NULL AFTER `description`,
  DROP COLUMN `link_name`,
  MODIFY `image_icon` VARCHAR(50) DEFAULT NULL;

-- Valor puramente numérico veio do INT legado e NUNCA é nome de ícone
-- Material — anular evita ícone quebrado silencioso no menu (gate 2026-08-04).
UPDATE `tb_module` SET `image_icon` = NULL
 WHERE `image_icon` = '' OR `image_icon` REGEXP '^[0-9]+$';

ALTER TABLE `tb_module_has_interface`
  ADD COLUMN `position` INT DEFAULT NULL AFTER `active`;
