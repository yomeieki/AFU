import { Router } from 'express'
import categoriesRouter from './categories'
import productsRouter from './products'
import adminRouter from './admin'
import cartRouter from './cart'
import addressRouter from './addresses'
import orderRouter from './orders'
import paymentRouter from './payments'
import scanLogRouter from './scan-logs'
import authRouter from './auth'
import { devUserMiddleware } from '../middlewares/dev-user'

export const router = Router()

// ── 公开接口 ──────────────────────────────────────────────
router.use('/categories', categoriesRouter)
router.use('/products', productsRouter)

// ── 认证接口 ──────────────────────────────────────────────
router.use('/auth', authRouter)

// ── 管理员接口 ────────────────────────────────────────────
router.use('/admin', adminRouter)

// ── 用户接口（devUserMiddleware：有 token 则解析，否则 userId=1）────
router.use('/cart', devUserMiddleware, cartRouter)
router.use('/addresses', devUserMiddleware, addressRouter)
router.use('/orders', devUserMiddleware, orderRouter)
router.use('/payments', paymentRouter)
router.use('/scan-logs', scanLogRouter)
