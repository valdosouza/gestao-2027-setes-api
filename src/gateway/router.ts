import { Router } from 'express'
import coreRoutes  from '@modules/core/core.routes'
import erpRoutes   from '@modules/erp/erp.routes'
import adminRoutes from '@modules/admin/admin.routes'
import countriesRoutes     from '@modules/countries/countries.routes'
import institutionsRoutes  from '@modules/institutions/institutions.routes'
import statesRoutes     from '@modules/states/states.routes'
import citiesRoutes     from '@modules/cities/cities.routes'
import interfacesRoutes from '@modules/interfaces/interfaces.routes'
import privilegesRoutes from '@modules/privileges/privileges.routes'
import interfaceFieldsRoutes from '@modules/interface-fields/interface-fields.routes'
import interfaceConfigsRoutes from '@modules/interface-configs/interface-configs.routes'
import usersRoutes from '@modules/users/users.routes'
import entitiesRoutes from '@modules/entities/entities.routes'
import customersRoutes from '@modules/customers/customers.routes'
import collaboratorsRoutes from '@modules/collaborators/collaborators.routes'
import { superGuard, superWriteGuard } from './super.guard'
import { adminGuard } from './admin.guard'

const router = Router()

router.use('/core',  coreRoutes)
router.use('/erp',   erpRoutes)
router.use('/admin', adminRoutes)

// Cadastros: 1 módulo = 1 rota raiz /api/<modulo>, espelho de /home/<modulo>
// no app (decisão do Valdo, 2026-07-11 — a URL segue o módulo, não o
// agrupador de menu). O guard vai POR MÓDULO: os cadastros do catálogo
// central são do Super (isSuper); cadastros de cliente terão guard próprio.
// Geográficos (fix 2026-07-18): leitura ABERTA a qualquer autenticado — os
// lookups da aba Endereços (país/UF/cidade) rodam em telas de CLIENTE
// (customers/collaborators/...); manutenção continua exclusiva do Super.
router.use('/countries',  superWriteGuard, countriesRoutes)
router.use('/states',     superWriteGuard, statesRoutes)
router.use('/cities',     superWriteGuard, citiesRoutes)
router.use('/interfaces', superGuard, interfacesRoutes)
router.use('/privileges', superGuard, privilegesRoutes)
router.use('/institutions', superGuard, institutionsRoutes)
// Usuários (workflow 2026-07-12): super gerencia qualquer institution
// (aba Usuários do Estabelecimento); ADMIN do cliente gerencia os do
// PRÓPRIO institution (módulo Sistema) — escopo forçado no service.
router.use('/users',        adminGuard, usersRoutes)

// Painel de campos configuráveis (Fase 2, decisões 6 e 9): módulo do CLIENTE
// (sem superGuard — privilégio da tela no app) e isento do gate de flags
// (o GET resolvido é infraestrutura de montagem de toda tela, como o core).
router.use('/interface-fields', interfaceFieldsRoutes)

// Painel de configurações do sistema (Framework de Configurações, decisões
// 7 e 9): módulo do CLIENTE no molde do interface-fields — sem superGuard
// (admin × usuário decidido no service) e isento do gate de flags (o GET
// resolvido por chave é infraestrutura de montagem de tela). O CRUD do
// CATÁLOGO vive em /api/interfaces/:id/configs (superGuard).
router.use('/interface-configs', interfaceConfigsRoutes)

// Busca por documento (Fase 3 Entidade Única, decisões 3 e 10): aberta a
// QUALQUER usuário autenticado — o prefill compartilhado é a feature; isenta
// do gate de flags (infraestrutura dos cadastros da cadeia fiscal).
router.use('/entities', entitiesRoutes)

// Clientes (Fase 3, decisão 8 — 1º cadastro do CLIENTE com a cadeia fiscal):
// sem superGuard — privilégio da tela é do app (decisão 21); escopo por
// institution forçado no service via JWT; gate técnico = flag 'customers'.
router.use('/customers', customersRoutes)

// Colaboradores (onda 2 da Entidade Única — hierarquia de papéis, decisão
// 16): mesmo desenho do customers — sem superGuard (privilégio da tela é do
// app); escopo por institution no service; gate técnico = flag 'collaborators'.
router.use('/collaborators', collaboratorsRoutes)

export default router
