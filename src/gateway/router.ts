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
import usersRoutes from '@modules/users/users.routes'
import { superGuard } from './super.guard'
import { adminGuard } from './admin.guard'

const router = Router()

router.use('/core',  coreRoutes)
router.use('/erp',   erpRoutes)
router.use('/admin', adminRoutes)

// Cadastros: 1 módulo = 1 rota raiz /api/<modulo>, espelho de /home/<modulo>
// no app (decisão do Valdo, 2026-07-11 — a URL segue o módulo, não o
// agrupador de menu). O guard vai POR MÓDULO: os cadastros do catálogo
// central são do Super (isSuper); cadastros de cliente terão guard próprio.
router.use('/countries',  superGuard, countriesRoutes)
router.use('/states',     superGuard, statesRoutes)
router.use('/cities',     superGuard, citiesRoutes)
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

export default router
