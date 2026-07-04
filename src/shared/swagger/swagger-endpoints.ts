/**
 * @swagger
 * /api/core/info:
 *   get:
 *     summary: Obter Informações do Tenant
 *     description: Retorna informações do tenant autenticado (via JWT)
 *     tags:
 *       - Core
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Informações do tenant
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Token JWT ausente ou inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Token não contém dados de tenant
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Erro ao buscar informações
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * /api/erp/status:
 *   get:
 *     summary: Status do Módulo ERP
 *     description: Retorna o status atual do módulo ERP
 *     tags:
 *       - ERP
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Status do módulo ERP
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 module:
 *                   type: string
 *                   example: "erp"
 *                 tenantId:
 *                   type: string
 *                   example: "tenant-001"
 *                 message:
 *                   type: string
 *                   example: "Módulo ERP ativo"
 *       401:
 *         description: Token JWT ausente ou inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Módulo não habilitado para este tenant
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Erro ao processar
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * /api/admin/tenants:
 *   get:
 *     summary: Listar Todos os Tenants
 *     description: Lista todos os tenants registrados (requer role setes_admin)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de tenants
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       schema_name:
 *                         type: string
 *                       active:
 *                         type: boolean
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *       401:
 *         description: Token JWT ausente ou inválido
 *       403:
 *         description: Acesso restrito à equipe Setes
 *       500:
 *         description: Erro ao listar tenants
 *
 *   post:
 *     summary: Criar Novo Tenant
 *     description: Cria um novo tenant (requer role setes_admin)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - schemaName
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Empresa XYZ"
 *               schemaName:
 *                 type: string
 *                 example: "schema_xyz"
 *     responses:
 *       201:
 *         description: Tenant criado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       400:
 *         description: Campos obrigatórios ausentes
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Token JWT ausente ou inválido
 *       403:
 *         description: Acesso restrito à equipe Setes
 *       500:
 *         description: Erro ao criar tenant
 */

// Este arquivo contém apenas documentação Swagger dos endpoints
// Importar em src/app.ts para incluir na documentação
export const endpointDocs = {}
