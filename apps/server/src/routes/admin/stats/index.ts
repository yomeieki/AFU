import { Router } from 'express'
import legacyRouter from './legacy'
import overviewRouter from './overview'
import localRouter from './local'
import expressRouter from './express'

const router = Router()
// 老接口：GET / 与 GET /trend（e2e §33 在用；口径已与下面三个统一）
router.use(legacyRouter)
// 新概览页：三个 tab 各一个接口，共用 shared.ts 的区间与订单口径
router.use(overviewRouter)
router.use(localRouter)
router.use(expressRouter)
export default router
