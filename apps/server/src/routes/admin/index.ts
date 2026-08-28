import { Router } from 'express'
import authRouter from './auth'
import categoriesRouter from './categories'
import productsRouter from './products'
import ordersRouter from './orders'
import statsRouter from './stats'
import scanStatsRouter from './scan-stats'
import bannersAdminRouter from './banners'
import systemRouter from './system'
import usersRouter from './users'
import uploadRouter from './upload'
import { verifyAdminToken } from '../../middlewares/auth'

const router = Router()

// Public: POST /login
router.use(authRouter)

// Protected routes
router.use(verifyAdminToken)
router.use('/categories', categoriesRouter)
router.use('/products', productsRouter)
router.use('/orders', ordersRouter)
router.use('/stats', statsRouter)
router.use('/scan-stats', scanStatsRouter)
router.use('/banners', bannersAdminRouter)
router.use('/system', systemRouter)
router.use('/users', usersRouter)
router.use('/upload', uploadRouter)

export default router
