import { Router } from 'express'
import categoriesRouter from './categories'
import productsRouter from './products'
import adminRouter from './admin'

export const router = Router()

// ── 公开接口 ──────────────────────────────────────────────
router.use('/categories', categoriesRouter)
router.use('/products', productsRouter)

// ── 管理员接口 ────────────────────────────────────────────
router.use('/admin', adminRouter)

// 后续阶段追加：
// router.use('/auth',       authRouter)
// router.use('/cart',       cartRouter)
// router.use('/addresses',  addressRouter)
// router.use('/orders',     orderRouter)
// router.use('/payments',   paymentRouter)
// router.use('/scan-logs',  scanLogRouter)
