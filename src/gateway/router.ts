import { Router } from 'express'
import coreRoutes  from '@modules/core/core.routes'
import erpRoutes   from '@modules/erp/erp.routes'
import adminRoutes from '@modules/admin/admin.routes'

const router = Router()

router.use('/core',  coreRoutes)
router.use('/erp',   erpRoutes)
router.use('/admin', adminRoutes)

export default router
