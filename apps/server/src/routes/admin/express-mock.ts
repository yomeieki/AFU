import { Router, Request, Response, NextFunction } from 'express'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { queueExpressDirective, getExpressCalls, resetExpressMock, ExpressMockDirective } from '../../services/delivery/express-mock'
import { clearExpressQuoteCache } from '../../services/express-quote-service'

const router = Router()

// POST /api/admin/system/express-mock/reset — 清指令队列 + 调用记录 + 服务端报价缓存
router.post('/reset', async (_req: Request, res: Response, next: NextFunction) => {
  try { resetExpressMock(); clearExpressQuoteCache(); success(res, {}) } catch (e) { next(e) }
})
// POST /api/admin/system/express-mock/queue — { directive }
router.post('/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = (req.body ?? {}).directive as ExpressMockDirective | undefined
    if (!d || !['ok', 'timeout', 'error'].includes(d.kind)) throw new AppError(40000, '无效指令', 400)
    queueExpressDirective(d); success(res, {})
  } catch (e) { next(e) }
})
// GET /api/admin/system/express-mock/calls
router.get('/calls', async (_req: Request, res: Response, next: NextFunction) => {
  try { success(res, getExpressCalls()) } catch (e) { next(e) }
})
export default router
