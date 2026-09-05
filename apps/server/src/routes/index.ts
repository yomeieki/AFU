import { Router } from 'express'
import categoriesRouter from './categories'
import productsRouter from './products'
import adminRouter from './admin'
import cartRouter from './cart'
import addressRouter from './addresses'
import orderRouter from './orders'
import scanLogRouter from './scan-logs'
import bannersRouter from './banners'
import authRouter from './auth'
import uploadRouter from './upload'
import localRouter from './local'
import { verifyUserToken } from '../middlewares/auth'
import { scanLogLimiter } from '../middlewares/rate-limit'

export const router = Router()

// ── 公开接口 ──────────────────────────────────────────────
router.use('/categories', categoriesRouter)
router.use('/products', productsRouter)
router.use('/local', localRouter)

// ── 认证接口 ──────────────────────────────────────────────
router.use('/auth', authRouter)

// ── 管理员接口 ────────────────────────────────────────────
router.use('/admin', adminRouter)

// ── 用户接口（必须携带有效用户 token）─────────────────────
router.use('/cart', verifyUserToken, cartRouter)
router.use('/addresses', verifyUserToken, addressRouter)
router.use('/orders', verifyUserToken, orderRouter)
router.use('/upload', verifyUserToken, uploadRouter)

// ── 扫码日志（可选认证：未登录也可记录，userId 为空；匿名可写库，必须限流）───────
router.use('/scan-logs', scanLogLimiter, scanLogRouter)
router.use('/banners', bannersRouter)
