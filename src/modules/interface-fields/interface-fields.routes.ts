import { Router } from 'express'
import * as controller from './interface-fields.controller'

/**
 * Rotas do módulo interface-fields — montadas em /api/interface-fields.
 * Espelho no app: apps/web/lib/app/modules/interface_fields/ (painel
 * Sistema/Admin — decisão 6 da Fase 2 de campos configuráveis).
 *
 * SEM superGuard: o painel é do CLIENTE (decisão 9 — privilégio da tela no
 * app). Módulo ISENTO do gate tb_feature_flag (como 'core'): o GET de campos
 * resolvidos é infraestrutura de montagem de TODA tela.
 */
const router = Router()

/**
 * @swagger
 * /api/interface-fields:
 *   get:
 *     summary: Vitrine de interfaces (TODAS as do produto, marcando as adquiridas — decisão 6)
 *     tags: [InterfaceFields]
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
 *     responses:
 *       200:
 *         description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, description, i18nKey, acquired, moduleNames }'
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/interface-fields/key/{moduleKey}:
 *   get:
 *     summary: Campos resolvidos pela CHAVE do módulo (engine de montagem das telas — decisão 7)
 *     tags: [InterfaceFields]
 *     parameters:
 *       - in: path
 *         name: moduleKey
 *         required: true
 *         schema: { type: string }
 *         description: i18n_key da interface = nome do módulo (ex. countries)
 *     responses:
 *       200:
 *         description: 'Lista resolvida ([] quando o módulo não tem catálogo)'
 */
router.get('/key/:moduleKey', controller.getFieldsByKey)

/**
 * @swagger
 * /api/interface-fields/{id}:
 *   get:
 *     summary: Campos RESOLVIDOS da interface (merge cliente → catálogo; inclui os travados)
 *     tags: [InterfaceFields]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: '{ ok, data: [{ fieldName, tableName, kind, requiredTech, required, caption, mask, customized }] }'
 *       404:
 *         description: Interface não encontrada
 */
router.get('/:id', controller.getFields)

/**
 * @swagger
 * /api/interface-fields/{id}/{fieldName}:
 *   put:
 *     summary: Salva a configuração de um campo (caption/required/mask — cliente só APERTA o baseline)
 *     tags: [InterfaceFields]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: fieldName
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fieldCaption: { type: string, nullable: true }
 *               required: { type: string, enum: [S, N], nullable: true, description: 'null herda o catálogo' }
 *               mask: { type: string, nullable: true, description: 'Padrão # = dígito, A = letra, demais literais' }
 *     responses:
 *       200: { description: 'Config salva' }
 *       400: { description: 'Validação falhou (ex.: tentar afrouxar campo técnico)' }
 *       403: { description: 'Interface não adquirida' }
 *       404: { description: 'Interface ou campo inexistente' }
 */
router.put('/:id/:fieldName', controller.putField)

export default router
