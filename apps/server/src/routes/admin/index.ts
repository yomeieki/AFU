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
import couponTemplatesRouter from './coupon-templates'
import pointsGoodsRouter from './points-goods'
import { verifyAdminToken } from '../../middlewares/auth'
import { config } from '../../config'
import kd100MockRouter from './kd100-mock'
import expressMockRouter from './express-mock'
import deliveryRouter from './delivery'
import workbenchRouter from './workbench'
import printerRouter, { printerMockRouter } from './printer'

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
if (config.mock.printer) router.use('/system/printer-mock', printerMockRouter)
if (config.mock.express) router.use('/system/express-mock', expressMockRouter)
router.use('/local/orders', deliveryRouter)
router.use('/workbench', workbenchRouter)
router.use('/users', usersRouter)
router.use('/upload', uploadRouter)
router.use('/settings', settingsRouter)
router.use('/coupon-templates', couponTemplatesRouter)
router.use('/points-goods', pointsGoodsRouter)
// printer.ts 自带完整相对路径（/settings/printer、/printers/*、/print-jobs*、/orders/:id/reprint），
// 挂在根上、放在 settingsRouter/ordersRouter 之后：两边都没有同名路由，穿透互不冲突（见该文件头注释）。
router.use('/', printerRouter)

export default router
