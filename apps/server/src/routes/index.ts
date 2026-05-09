import { Router } from 'express'
import categoriesRouter from './categories'
import productsRouter from './products'
import adminRouter from './admin'
import cartRouter from './cart'
import addressRouter from './addresses'
import orderRouter from './orders'
import paymentRouter from './payments'
import scanLogRouter from './scan-logs'
import { devUserMiddleware } from '../middlewares/dev-user'

export const router = Router()

// ── 公开接口 ──────────────────────────────────────────────
router.use('/categories', categoriesRouter)
router.use('/products', productsRouter)

// ── 管理员接口 ────────────────────────────────────────────
router.use('/admin', adminRouter)

// ── 用户接口（阶段 4：dev user 中间件；阶段 7 换成 verifyUserToken）────
router.use('/cart', devUserMiddleware, cartRouter)
router.use('/addresses', devUserMiddleware, addressRouter)
router.use('/orders', devUserMiddleware, orderRouter)
router.use('/payments', paymentRouter)
router.use('/scan-logs', scanLogRouter)
