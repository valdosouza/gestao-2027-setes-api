-- 075 — VIEWs do veredito de acesso POR SCHEMA de cliente: vw_user_reach + vw_user_access (costura A1 da frente auth-api — D-AU3/D-AU6/
-- D-AU8, Valdo 2026-10-31; Infra-IA/prompts/prompt_frente_auth_api.md, parecer do guardião no §7).
--
-- A pilha (cada predicado UMA vez): setes_central.vw_user_link (vínculo vivo + perfil) e setes_central.vw_interface_catalog (interface viva
-- + modo de concessão) — script sql/70, aplicado ANTES deste — e, aqui:
--   vw_user_reach  — interface AO ALCANCE do usuário no estabelecimento: o super todas (A-PV1/D-PV24); a tela do Super DELEGÁVEL só para
--                    o usuário da Setes, NUNCA pela licença (D-PV11 (c)/D-PV39 — a aba do Super vincula qualquer tela a qualquer cliente,
--                    então a delegável fica fora da licença por construção); as demais pela licença (`tb_institution_has_interface`
--                    viva — D-F14/D-F37). É a "licença sozinha" das leituras (Q-N32) e o MOTIVO do 403 (lida só na negação).
--   vw_user_access — verbo PERMITIDO (presença = permissão — D-AU3): todo par REGISTRADO (`tb_interface_has_privilege` vivo) da interface
--                    alcançada, para o super; para o admin, menos nas delegáveis (D-PV11 (b): até o admin precisa do privilégio marcado
--                    pelo Super); para os demais (e a delegável), a CONCESSÃO viva sobre par registrado (D-PV50 item 4).
-- O grupo Super NÃO entra aqui (D-PV55 é regra do MENU, segue no SQL do menu). O único leitor é a biblioteca `fiscal-api/access`.
--
-- FUNDÍVEL (PADROES §11 regra 3): um SELECT por view, sem UNION/DISTINCT/GROUP BY/LIMIT; a de acesso compõe a de alcance (o MariaDB funde
-- as duas). As linhas da institution 1 aparecem também nos schemas de outros clientes nos ramos super/delegável — inalcançáveis: o leitor
-- filtra pela institution do token e a sessão viva confere o `schema_name` (fecha por construção na D-GE22, onda 1 do grupo).
-- Lugares reservados (só uma linha cada, quando a decisão executar): D-GE3 (onda 0 do grupo) → `AND g.tb_institution_id =
-- r.tb_institution_id` na concessão; D-GE22 (onda 1) → a licença pela chave do GRUPO; Q-EA7 (não decidida) → coluna na vw_user_link.
--
-- `privilege` com COLLATE utf8mb4_bin: o verbo é citado pelo NOME (D-PV53), exato. Re-executável (CREATE OR REPLACE). Rodar com o usuário
-- dono de sempre (DEFINER). Espelho no canônico (`sql/03_*.sql`, bloco das VIEWs) no MESMO passo do merge — com `SET NAMES utf8mb4` antes.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW `vw_user_reach` AS
SELECT l.`tb_user_id`,
       l.`tb_institution_id`,
       c.`tb_interface_id`,
       c.`interface_key`,
       l.`profile`,
       c.`delegable`
  FROM `setes_central`.`vw_user_link` l
 CROSS JOIN `setes_central`.`vw_interface_catalog` c
  LEFT JOIN `tb_institution_has_interface` ihi
    ON ihi.`tb_institution_id` = l.`tb_institution_id`
   AND ihi.`tb_interface_id` = c.`tb_interface_id`
   AND ihi.`active` = 'S' AND ihi.`deleted` = 'N'
 WHERE l.`profile` = 'super'
    OR (c.`delegable` = 'S' AND l.`vendor` = 'S')
    OR (c.`delegable` = 'N' AND ihi.`tb_interface_id` IS NOT NULL);

CREATE OR REPLACE SQL SECURITY DEFINER VIEW `vw_user_access` AS
SELECT r.`tb_user_id`,
       r.`tb_institution_id`,
       r.`tb_interface_id`,
       r.`interface_key`,
       p.`id` AS `tb_privilege_id`,
       p.`description` COLLATE utf8mb4_bin AS `privilege`,
       r.`profile`,
       r.`delegable`
  FROM `vw_user_reach` r
  JOIN `setes_central`.`tb_interface_has_privilege` ihp
    ON ihp.`tb_interface_id` = r.`tb_interface_id` AND ihp.`active` = 'S' AND ihp.`deleted` = 'N'
  JOIN `setes_central`.`tb_privilege` p
    ON p.`id` = ihp.`tb_privilege_id` AND p.`deleted` = 'N'
  LEFT JOIN `tb_user_has_privilege` g
    ON g.`tb_user_id` = r.`tb_user_id`
   AND g.`tb_interface_id` = ihp.`tb_interface_id`
   AND g.`tb_privilege_id` = ihp.`tb_privilege_id`
   AND g.`active` = 'S' AND g.`deleted` = 'N'
 WHERE r.`profile` = 'super'
    OR (r.`profile` = 'admin' AND r.`delegable` = 'N')
    OR g.`tb_user_id` IS NOT NULL;
