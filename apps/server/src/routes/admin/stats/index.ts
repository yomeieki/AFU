import { Router } from 'express'
import legacyRouter from './legacy'

const router = Router()
// 老接口：GET / 与 GET /trend（后台旧概览与 e2e §33 在用）
router.use(legacyRouter)
export default router
