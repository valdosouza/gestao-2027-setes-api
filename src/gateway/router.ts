import { Router } from 'express'
import coreRoutes  from '@modules/core/core.routes'
import erpRoutes   from '@modules/erp/erp.routes'
import adminRoutes from '@modules/admin/admin.routes'
import countriesRoutes  from '@modules/countries/countries.routes'
import statesRoutes     from '@modules/states/states.routes'
import citiesRoutes     from '@modules/cities/cities.routes'
import interfacesRoutes from '@modules/interfaces/interfaces.routes'
import privilegesRoutes from '@modules/privileges/privileges.routes'
import { superGuard } from './super.guard'

const router = Router()

router.use('/core',  coreRoutes)
router.use('/erp',   erpRoutes)
router.use('/admin', adminRoutes)

// Área Super: "Super" NÃO é módulo de código — é agrupador de menu no app
// e aqui apenas prefixo de URL + guard (simetria com o setes-app, onde
// 1 interface = 1 módulo e módulo de sistema nunca vira pasta).
// URLs preservadas: /api/super/<modulo>[...].
const superArea = Router()
superArea.use(superGuard)
superArea.use('/countries',  countriesRoutes)
superArea.use('/states',     statesRoutes)
superArea.use('/cities',     citiesRoutes)
superArea.use('/interfaces', interfacesRoutes)
superArea.use('/privileges', privilegesRoutes)
router.use('/super', superArea)

export default router
