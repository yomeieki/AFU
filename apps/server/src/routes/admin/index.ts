import { Router } from 'express'
import authRouter from './auth'

const router = Router()

// POST /login  →  POST /api/admin/login
router.use(authRouter)

export default router
