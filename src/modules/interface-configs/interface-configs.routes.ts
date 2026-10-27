import { Router } from 'express'
import { privilegeAct, openRoute } from '@shared/auth/module-privilege-gate'
import { PRIVILEGE_VISUALIZAR } from '@shared/auth/privileges'
import { CONFIGS_PANEL, CONFIGS_VITRINE } from './interface-configs.privilege-policy'
import * as controller from './interface-configs.controller'

/**
 * Rotas do módulo interface-configs — montadas em /api/interface-configs.
 * Espelho no app: apps/web/lib/app/modules/interface_configs/ (painel do
 * cliente — decisões 7 e 9 do Framework de Configurações do Sistema).
 *
 * SEM superGuard: o painel é do CLIENTE (operável por qualquer usuário com
 * privilégio na tela; admin edita valores da institution, usuário comum os
 * próprios overrides scope 'U' — enforcement no service). Módulo ISENTO do
 * gate tb_feature_flag (como interface-fields): o GET resolvido por chave é
 * infraestrutura de montagem de tela.
 *
 * O CRUD do CATÁLOGO fica no módulo interfaces (/api/interfaces/:id/configs,
 * superGuard — decisão 7: seção "Configurações" da tela de Interfaces).
 */
const router = Router()

/**
 * @swagger
 * /api/interface-configs:
 *   get:
 *     summary: Vitrine de interfaces do painel de configurações (todas, marcando adquiridas)
 *     tags: [InterfaceConfigs]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtro por nome da interface
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *       - in: query
 *         name: criteria
 *         schema: { type: string }
 *         description: 'Pesquisa avançada (D-BA1) — JSON { chave: valor } com as chaves de GET /search-criteria. Desconhecida/malformada = 400 SEARCH_CRITERIA_INVALID; valor inválido = 422 SEARCH_CRITERION_INVALID com fields[]'
 *     responses:
 *       200:
 *         description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, description, i18nKey, acquired, moduleNames }'
 */
// A-PV8 (superada em parte pela D-PV25): a vitrine e o painel de UMA interface também abrem pela "Configurações Gerais"
// (general-configs — sem módulo próprio: o clique no menu abre este painel filtrado nela) — o VISUALIZAR dela deixa NAVEGAR
// até o painel dela; a gravação do valor 'I' é CONFIGURAR em general-configs (a interface alvo é ela mesma).
router.get('/', privilegeAct(PRIVILEGE_VISUALIZAR, CONFIGS_VITRINE), controller.list)

/**
 * @swagger
 * /api/interface-configs/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da vitrine do painel de configurações
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA20, Onda 2 §12) — lista branca da
 *       peça @shared/interface-vitrine, sem expressão SQL. "name" olha a descrição técnica (Q-BA26).
 *     tags: [InterfaceConfigs]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind, labelKey }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', privilegeAct(PRIVILEGE_VISUALIZAR, CONFIGS_VITRINE), controller.searchCriteria)

/**
 * @swagger
 * /api/interface-configs/key/{moduleKey}:
 *   get:
 *     summary: Configs resolvidas pela CHAVE do módulo (engine de consumo do app — decisão 4)
 *     tags: [InterfaceConfigs]
 *     parameters:
 *       - in: path
 *         name: moduleKey
 *         required: true
 *         schema: { type: string }
 *         description: i18n_key da interface = nome do módulo (ex. customers)
 *     responses:
 *       200:
 *         description: 'Lista resolvida usuário → institution → default ([] sem catálogo)'
 */
// D-PV2 (exceção nomeada): a config resolvida monta TODA tela — sem privilégio do painel
router.get('/key/:moduleKey', openRoute('config resolvida que monta toda tela'), controller.getConfigsByKey)

/**
 * @swagger
 * /api/interface-configs/key/{moduleKey}/{name}:
 *   put:
 *     summary: Salva o valor de uma configuração pela CHAVE do módulo (paginação D4 — seletor de itens/página)
 *     tags: [InterfaceConfigs]
 *     parameters:
 *       - in: path
 *         name: moduleKey
 *         required: true
 *         schema: { type: string }
 *         description: i18n_key da interface = nome do módulo (ex. customers)
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content, target]
 *             properties:
 *               content: { type: string, nullable: true, description: 'null volta a herdar (institution → default)' }
 *               target: { type: string, enum: [U], description: "só o override PESSOAL — 'I' (valor da institution) vai pelo PUT /{id}/{name}" }
 *     responses:
 *       200: { description: 'Valor salvo' }
 *       400: { description: 'Valor incompatível com o kind do catálogo' }
 *       403: { description: "Interface não adquirida / config sem override por usuário / target 'I' (CONFIG_INSTITUTION_VIA_PANEL)" }
 *       404: { description: 'Interface ou configuração inexistente' }
 */
// A-PV6: o seletor de itens/página de TODA lista grava aqui o override PESSOAL (scope U) — porta ABERTA, então só 'U'
// (o controller recusa 'I'): o valor da institution tem UMA porta, a do painel guardado (`PUT /:id/:name`).
router.put('/key/:moduleKey/:name', openRoute('override pessoal (page_size) gravado por toda lista'), controller.putValueByKey)

/**
 * @swagger
 * /api/interface-configs/{id}:
 *   get:
 *     summary: Configs RESOLVIDAS da interface (efetivo + valor institution + override do usuário)
 *     tags: [InterfaceConfigs]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: '{ ok, data: [{ name, description, kind, options, defaultContent, scope, institutionContent, userContent, content, canConfigure }] } — canConfigure (D-PV25): quem pede tem CONFIGURAR na interface alvo (decide o alvo I × U do salvar)'
 *       404:
 *         description: Interface não encontrada
 */
router.get('/:id', privilegeAct(PRIVILEGE_VISUALIZAR, CONFIGS_PANEL), controller.getConfigs)

/**
 * @swagger
 * /api/interface-configs/{id}/{name}:
 *   put:
 *     summary: Salva o valor de uma configuração (target I = quem tem CONFIGURAR na interface ALVO — D-PV25/D-PV26; U = override pessoal)
 *     tags: [InterfaceConfigs]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content, target]
 *             properties:
 *               content: { type: string, nullable: true, description: 'null volta a herdar (institution → default)' }
 *               target: { type: string, enum: [I, U], description: 'I = valor da institution (exige CONFIGURAR na interface alvo — admin passa, super escapa); U = override do usuário' }
 *     responses:
 *       200: { description: 'Valor salvo (só grava o que diverge do herdado)' }
 *       400: { description: 'Valor incompatível com o kind do catálogo' }
 *       403: { description: 'Interface não adquirida (INTERFACE_NOT_ALLOWED) / sem CONFIGURAR na interface alvo (PRIVILEGE_REQUIRED) / config sem override por usuário' }
 *       404: { description: 'Interface ou configuração inexistente' }
 */
// D-PV25 (1): o VISUALIZAR do painel só deixa NAVEGAR — quem decide a gravação do valor 'I' é o service, pelo veredito CONFIGURAR
// da interface ALVO (`@shared/auth/configure-privilege`). O ALTERAR do painel perdeu o consumidor (sai do catálogo — seed 68, C1).
router.put('/:id/:name', privilegeAct(PRIVILEGE_VISUALIZAR, CONFIGS_PANEL), controller.putValue)

export default router
