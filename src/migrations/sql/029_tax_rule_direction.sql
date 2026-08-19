-- 029 — Sentido OBRIGATÓRIO na Regra de Tributação (decisão 35 da fase
-- Faturamento Fiscal e Financeiro — fecha Q-G1 dos gates e RA-Q3 do app).
--
-- Paridade com o legado: o WHERE do motor SEMPRE filtrava o sentido
-- (NAT_SENTIDO = :sentido, tributacao.md §2) e toda regra tinha sentido por
-- construção (toda regra tinha natureza; natureza sempre tem sentido). Na
-- web a regra DECLARA o próprio sentido: `direction` E/S sem coringa — não
-- existe regra que valha para os dois sentidos ("Ambos" morreu no app).
-- O sentido da OPERAÇÃO vem do `way` da natureza (tb_cfop) no faturamento.
--
-- Parte CENTRAL (idempotente — a migration roda por schema): "não deve
-- existir CFOP sem way" — normaliza pelo PRIMEIRO DÍGITO, que é a definição
-- fiscal (1/2/3 = entrada; 5/6/7 = saída). Corrige também way divergente
-- (caso real em dev: 6411 estava 'E'). Resíduo que não começa em 1-3/5-7
-- (ex.: '0000' importado do legado) não é CFOP válido — fica como está e a
-- validação da peça @shared/tax-rule barra o uso em regra.

UPDATE `setes_central`.`tb_cfop`
   SET `way` = 'E'
 WHERE LEFT(`id`, 1) IN ('1', '2', '3')
   AND (`way` IS NULL OR `way` <> 'E');

UPDATE `setes_central`.`tb_cfop`
   SET `way` = 'S'
 WHERE LEFT(`id`, 1) IN ('5', '6', '7')
   AND (`way` IS NULL OR `way` <> 'S');

-- Parte do SCHEMA DO CLIENTE: backfill do direction antes do NOT NULL —
-- regra com CFOP herda o way da natureza; sem CFOP assume 'S' (saída/venda,
-- o caso dominante — revisável pela tela).

-- COLLATE explícito no JOIN: catálogo central é utf8mb4_general_ci × schema
-- do cliente utf8mb4_unicode_ci (o mesmo mismatch que barrou FK física de
-- string — decisão 33/PADROES §5).
UPDATE `tb_tax_rule` r
  JOIN `setes_central`.`tb_cfop` c
    ON c.`id` COLLATE utf8mb4_unicode_ci = r.`tb_cfop_id`
   SET r.`direction` = c.`way`
 WHERE (r.`direction` IS NULL OR r.`direction` NOT IN ('E', 'S'))
   AND c.`way` IN ('E', 'S');

UPDATE `tb_tax_rule`
   SET `direction` = 'S'
 WHERE `direction` IS NULL OR `direction` NOT IN ('E', 'S');

ALTER TABLE `tb_tax_rule`
  MODIFY COLUMN `direction` char(1) NOT NULL DEFAULT 'S';
