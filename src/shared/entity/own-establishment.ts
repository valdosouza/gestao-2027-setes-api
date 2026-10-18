import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'

/**
 * O PRÓPRIO estabelecimento não se cadastra como papel (cliente, fornecedor, transportadora, colaborador) — gate adversarial da
 * D-PV2 (HIGH, 2026-10-18 — `Infra-IA/prompts/prompt_privilegios_interfaces.md` §11, Q-PV28): o reuso pelo documento (Fase 3)
 * resolvia o CNPJ da empresa para a entity da INSTITUTION, e a aba Tributação do papel gravava a linha do EMITENTE em
 * `tb_entity_tax` (regime do Simples, apuração, pTotTribSN — o que a nfse-api lê para o DPS de produção), e a cadeia (razão social,
 * IE/IM, endereços) na mesma transação — por fora do `adminGuard` e das validações do Meu Estabelecimento (D41/D-PV5,
 * Q-N36/Q-N37). INTERINO até a Q-PV28 (em 2026-10-18 nenhum papel da Setes é a própria Setes — nada muda nos dados).
 * O id da institution É o id da entity dela (`tb_institution.id = tb_entity.id`).
 */
export function assertNotOwnEstablishment(entityId: number, institutionId: number): void {
  if (entityId !== institutionId) return
  throw new HttpError(409,
    'Este documento é o do próprio estabelecimento — os dados e a tributação dele se editam em Meu Estabelecimento',
    [{ field: 'cnpj', message: 'Documento do próprio estabelecimento' }], ErrorCodes.ROLE_IS_OWN_ESTABLISHMENT)
}
