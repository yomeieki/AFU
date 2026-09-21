import { Router, Request, Response, NextFunction } from 'express'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { queueRefundQueryDirective, getPayMockCalls, resetPayMock, RefundQueryDirective } from '../../services/wechat-pay-mock'

const router = Router()

// POST /api/admin/system/pay-mock/reset — 清指令队列 + 调用记录
router.post('/reset', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    resetPayMock()
    success(res, {})
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/system/pay-mock/refund-query — { outRefundNo?, directive }
router.post('/refund-query', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { outRefundNo?: string; directive?: RefundQueryDirective }
    const d = body.directive
    if (!d || !['ok', 'not_found', 'error', 'timeout'].includes(d.kind)) throw new AppError(40000, '无效指令', 400)
    if (d.kind === 'ok') {
      if (!['SUCCESS', 'CLOSED', 'PROCESSING', 'ABNORMAL'].includes(d.status)) throw new AppError(40000, 'status 需为四值之一', 400)
      if (d.amount !== undefined && (!Number.isInteger(d.amount) || d.amount < 0)) throw new AppError(40000, 'amount 需为非负整数', 400)
    }
    if (d.kind === 'error' && (typeof d.code !== 'string' || !d.code)) throw new AppError(40000, 'error 指令需要 code', 400)
    queueRefundQueryDirective(d, body.outRefundNo ?? '*')
    success(res, {})
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/system/pay-mock/calls?op=queryRefund
router.get('/calls', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const op = req.query.op as 'queryRefund' | undefined
    if (op !== undefined && op !== 'queryRefund') throw new AppError(40000, '无效 op', 400)
    success(res, getPayMockCalls(op ?? 'queryRefund'))
  } catch (e) {
    next(e)
  }
})

export default router
