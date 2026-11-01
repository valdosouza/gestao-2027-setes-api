import { Router } from 'express'
import { byDocument } from './entities.controller'

const router = Router()

/**
 * @swagger
 * /api/entities/by-document:
 *   get:
 *     summary: Buscar entidade pelo documento (CPF/CNPJ)
 *     description: >
 *       Prefill da Fase 3 (Entidade Única, decisões 3, 9 e 10) — ao sair do
 *       campo de documento, o app consulta aqui; se a entidade já existe em
 *       setes_central, recebe a cadeia completa (entity + fiscal + endereços
 *       + fones + redes sociais) e a lista informativa de papéis existentes
 *       (institution global; customer/salesman/carrier na institution do
 *       usuário logado). Aberto a qualquer usuário autenticado — o prefill
 *       compartilhado é a feature. A resolução definitiva acontece de novo
 *       dentro da transação do salvar (o app nunca envia entityId).
 *     tags: [Entities]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: personType
 *         required: true
 *         schema: { type: string, enum: [F, J] }
 *         description: F = busca por CPF (tb_person); J = busca por CNPJ (tb_company)
 *       - in: query
 *         name: doc
 *         required: true
 *         schema: { type: string }
 *         description: >
 *           CPF (11 dígitos) ou CNPJ (12 letras/números + 2 DV — alfanumérico desde 07/2026), com ou sem máscara: a leitura
 *           canonicaliza pela peça da inscrição federal (tira só . / - e espaço, sobe minúscula, nunca apaga) e compara por igualdade (D-CJ3)
 *     responses:
 *       200:
 *         description: >
 *           Envelope { ok, data } — data.found=false quando o documento é
 *           inédito; found=true traz data.entity (cadeia completa) e
 *           data.roles (ex.: ["institution","customer"])
 *       400:
 *         description: personType inválido ou documento com dígito verificador errado
 *       401:
 *         description: Não autenticado
 *       500:
 *         description: Erro interno
 */
router.get('/by-document', byDocument)

// D-PV23/D-PV30 (Valdo 2026-10-20, fecham a Q-PV14 (a) e a Q-PV25 (a)): as rotas AVULSAS `GET/PUT /:id/tax` SAÍRAM. Elas gravavam
// `tb_entity_tax` (os FATOS fiscais da relação) por fora do ALTERAR do papel e das validações do Meu Estabelecimento — o gate
// adversarial da D-PV2 as achou (HIGH, interino `adminGuard`). As três vias da REGRA de tributação (geral, por produto, por
// cliente) são pelo cadastro de origem; a tributação da RELAÇÃO se edita na aba Tributação do PAPEL (na transação dele) e a do
// emitente no Meu Estabelecimento. Sem consumidor no app. A sonda do gate virou cerca: `adversarial-pv2-gate.test.ts`.

export default router
