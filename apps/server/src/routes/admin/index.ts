import { Router } from 'express'
import authRouter, { createWebviewCode } from './auth'
import categoriesRouter from './categories'
import productsRouter from './products'
import ordersRouter from './orders'
import afterSalesRouter from './after-sales'
import statsRouter from './stats'
import scanStatsRouter from './scan-stats'
import bannersAdminRouter from './banners'
import systemRouter from './system'
import usersRouter from './users'
import uploadRouter from './upload'
import settingsRouter from './settings'
import { verifyAdminToken } from '../../middlewares/auth'
import { config } from '../../config'
import kd100MockRouter from './kd100-mock'
import deliveryRouter from './delivery'
import workbenchRouter from './workbench'

const router = Router()

// Public: POST /login
router.use(authRouter)

// Protected routes
router.use(verifyAdminToken)
router.use('/categories', categoriesRouter)
router.use('/products', productsRouter)
router.use('/orders', ordersRouter)
router.use('/after-sales', afterSalesRouter)
router.post('/webview-code', createWebviewCode)
router.use('/stats', statsRouter)
router.use('/scan-stats', scanStatsRouter)
router.use('/banners', bannersAdminRouter)
router.use('/system', systemRouter)
// Mock control plane: only in dev/e2e (production disables via config layer)
if (config.mock.delivery) router.use('/system/kd100-mock', kd100MockRouter)
router.use('/local/orders', deliveryRouter)
router.use('/workbench', workbenchRouter)
router.use('/users', usersRouter)
router.use('/upload', uploadRouter)
router.use('/settings', settingsRouter)

export default router
