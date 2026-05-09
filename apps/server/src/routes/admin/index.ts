import { Router } from 'express'
import authRouter from './auth'
import categoriesRouter from './categories'
import productsRouter from './products'
import ordersRouter from './orders'
import statsRouter from './stats'
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

export default router
