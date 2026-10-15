-- 070 — Fase IBS/CBS, IB-2: a DECLARAÇÃO IBS/CBS congelada no ramo de serviço é um TRIO (D-IB62/D-IB71 —
-- Infra-IA/prompts/prompt_fase_ibs_cbs.md §12.6). As colunas nasceram na 066 (formato por CHECK, sem produtor); a IB-2
-- liga o produtor ÚNICO (@shared/invoice.issueInvoice, a partir da composição @shared/service-ibscbs-declaration) e
-- fecha a FORMA da declaração no banco — guarda contra SQL direto/carga gravar um grupo que o fisco rejeitaria:
--   (1) o par do grupo IBSCBS vem completo ou não vem: cClassTrib sem cIndOp (ou o contrário) não existe;
--   (2) grupo exige NBS (regra E0322 do Anexo I da NFS-e — "obrigatório informar um item da NBS se for declarada
--       qualquer informação de IBS/CBS"); a NBS SOZINHA (sem o grupo) é permitida (D-IB62: vai como cNBS).
-- Linhas existentes: as 3 colunas são NULL em toda nota (nenhum produtor até aqui) — os CHECKs valem para elas.
-- revisar-ddl: sem coluna/tabela nova; IS NULL não depende de colação; re-executável por ADD CONSTRAINT IF NOT EXISTS
-- (MariaDB 10.4 — PADROES §11 regra 11 (c)); provado em schema descartável antes da árvore viva (D-IB73).

ALTER TABLE `tb_invoice_service`
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_ibscbs_pair`
    CHECK ((`classification_code` IS NULL) = (`place_indicator_code` IS NULL)),
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_ibscbs_requires_nbs`
    CHECK (`classification_code` IS NULL OR `nbs` IS NOT NULL);
