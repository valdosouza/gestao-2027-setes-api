-- 057 — Vocabulário da voz do banco ganha 'E' (efeito reaplicado) — Rodada 2 da Onda 2
-- Banco Inter (D-I25 = Q-I1, Valdo 2026-09-21 "siga as recomendações"; ver
-- prompts/prompt_onda2_banco_inter.md §10.9).
--
-- Quando o banco diz RECEBIDO/CANCELADO/EXPIRADO e a NOSSA regra recusa o efeito
-- (caixa fechado, boleto fora de 'open'...), o fato fica gravado com `slip_event`
-- NULL (D-I10). Corrigida a causa, o operador REAPLICA pelo ato manual: a mesma
-- porta de efeitos recebe a voz já gravada. A idempotência por (kind, dt) impede
-- um 2º R — por isso a reaplicação é evento PRÓPRIO 'E', final como a voz que
-- reaplica (`slip_event` do E = efeito produzido; o R/C/V original recebe o mesmo
-- `slip_event` e deixa de ser pendência). Só o COMENTÁRIO muda: CHAR(1) sem CHECK,
-- como as demais famílias de evento (estado derivado pela peça, não pelo banco).
ALTER TABLE `tb_bank_slip_registration_event`
  MODIFY `kind` CHAR(1) NOT NULL
    COMMENT 'S enviado · G registrado (A_RECEBER) · R recebido · M marcado recebido · A atrasado · P protesto · C cancelado no banco · V expirado · F falha (FALHA_EMISSAO / POST recusado) · K cancelamento pedido por nós · E efeito reaplicado (ato manual sobre R/C/V com efeito recusado — D-I25)';
