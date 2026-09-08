import { Router, Request, Response, NextFunction } from 'express'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { queueExpressDirective, getExpressCalls, resetExpressMock, ExpressMockDirective, ExpressMockOp } from '../../services/delivery/express-mock'
import { clearExpressQuoteCache } from '../../services/express-quote-service'
import prisma from '../../utils/prisma'

const router = Router()

const OPS: ExpressMockOp[] = ['batchPrice', 'book', 'cancel', 'modify', 'detail', 'synPay']

// POST /api/admin/system/express-mock/reset — 清指令队列 + 调用记录 + 服务端报价缓存
router.post('/reset', async (_req: Request, res: Response, next: NextFunction) => {
  try { resetExpressMock(); clearExpressQuoteCache(); success(res, {}) } catch (e) { next(e) }
})
// POST /api/admin/system/express-mock/queue — { op?: ExpressMockOp, directive }
router.post('/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { op?: string; directive?: ExpressMockDirective }
    const op = (body.op ?? 'batchPrice') as ExpressMockOp
    if (!OPS.includes(op)) throw new AppError(40000, '无效 op', 400)
    const d = body.directive
    if (!d || !['ok', 'timeout', 'error'].includes(d.kind)) throw new AppError(40000, '无效指令', 400)
    if (d.kind === 'error' && (typeof d.code !== 'string' || !d.code)) throw new AppError(40000, 'error 指令需要 code', 400)
    if (d.kind === 'ok') {
      if (d.quotes !== undefined && !Array.isArray(d.quotes)) throw new AppError(40000, 'quotes 需为数组', 400)
      if (d.status !== undefined && typeof d.status !== 'number') throw new AppError(40000, 'status 需为数字', 400)
      if (d.found !== undefined && typeof d.found !== 'boolean') throw new AppError(40000, 'found 需为布尔', 400)
      for (const k of ['taskId', 'kdOrderId', 'courierName', 'courierMobile'] as const) {
        if (d[k] !== undefined && typeof d[k] !== 'string') throw new AppError(40000, `${k} 需为字符串`, 400)
      }
      if (d.kuaidinum !== undefined && d.kuaidinum !== null && typeof d.kuaidinum !== 'string') throw new AppError(40000, 'kuaidinum 需为字符串或 null', 400)
    }
    queueExpressDirective(d, op); success(res, {})
  } catch (e) { next(e) }
})
// GET /api/admin/system/express-mock/calls?op=book
router.get('/calls', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const op = req.query.op as ExpressMockOp | undefined
    if (op !== undefined && !OPS.includes(op)) throw new AppError(40000, '无效 op', 400)
    success(res, getExpressCalls(op))
  } catch (e) { next(e) }
})
// GET /api/admin/system/express-mock/salt/:bookingNo — e2e 构造合法回调用
router.get('/salt/:bookingNo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = await prisma.expressBooking.findUnique({ where: { bookingNo: String(req.params.bookingNo) }, select: { callbackSalt: true } })
    if (!b) throw new AppError(40401, '预约不存在', 404)
    success(res, { salt: b.callbackSalt })
  } catch (e) { next(e) }
})

export default router
