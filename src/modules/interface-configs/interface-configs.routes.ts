import { Router } from 'express'
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
 *     responses:
 *       200:
 *         description: '{ ok, data: [{ id, description, i18nKey, acquired, moduleNames }] }'
 */
router.get('/', controller.list)

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
router.get('/key/:moduleKey', controller.getConfigsByKey)

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
 *         description: '{ ok, data: [{ name, description, kind, options, defaultContent, scope, institutionContent, userContent, content }] }'
 *       404:
 *         description: Interface não encontrada
 */
router.get('/:id', controller.getConfigs)

/**
 * @swagger
 * /api/interface-configs/{id}/{name}:
 *   put:
 *     summary: Salva o valor de uma configuração (admin=institution; usuário=override scope U)
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
 *               target: { type: string, enum: [I, U], description: 'I = valor da institution (admin); U = override do usuário' }
 *     responses:
 *       200: { description: 'Valor salvo (só grava o que diverge do herdado)' }
 *       400: { description: 'Valor incompatível com o kind do catálogo' }
 *       403: { description: 'Interface não adquirida / sem permissão para o target' }
 *       404: { description: 'Interface ou configuração inexistente' }
 */
router.put('/:id/:name', controller.putValue)

export default router
