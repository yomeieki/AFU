import { Router, Request, Response, NextFunction } from 'express'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import {
  queueRefundQueryDirective,
  queueRefundCreateDirective,
  applyMockRefundNotify,
  getPayMockCalls,
  resetPayMock,
  RefundQueryDirective,
  RefundCreateDirective,
} from '../../services/wechat-pay-mock'

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

// POST /api/admin/system/pay-mock/refund-create — { orderId?, directive }（P2/P3 e2e 用：模拟 createRefund 的同步返回/异常）
router.post('/refund-create', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { orderId?: number; directive?: RefundCreateDirective }
    const d = body.directive
    if (!d || !['ok', 'error', 'timeout'].includes(d.kind)) throw new AppError(40000, '无效指令', 400)
    if (d.kind === 'ok') {
      if (!['SUCCESS', 'CLOSED', 'PROCESSING', 'ABNORMAL'].includes(d.status)) throw new AppError(40000, 'status 需为四值之一', 400)
      if (d.amount !== undefined && (!Number.isInteger(d.amount) || d.amount < 0)) throw new AppError(40000, 'amount 需为非负整数', 400)
      if (d.preemptNotify && !['SUCCESS', 'CLOSED', 'ABNORMAL'].includes(d.preemptNotify.status)) {
        throw new AppError(40000, 'preemptNotify.status 需为三值之一', 400)
      }
    }
    if (d.kind === 'error' && (typeof d.code !== 'string' || !d.code)) throw new AppError(40000, 'error 指令需要 code', 400)
    if (body.orderId !== undefined && (!Number.isInteger(body.orderId) || body.orderId <= 0)) throw new AppError(40000, 'orderId 需为正整数', 400)
    queueRefundCreateDirective(d, body.orderId ?? '*')
    success(res, {})
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/system/pay-mock/refund-notify — { outRefundNo, status }（在两次请求之间插一次「回调」）
router.post('/refund-notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { outRefundNo?: string; status?: string }
    if (!body.outRefundNo) throw new AppError(40000, '缺少 outRefundNo', 400)
    if (!body.status || !['SUCCESS', 'CLOSED', 'ABNORMAL'].includes(body.status)) throw new AppError(40000, 'status 需为三值之一', 400)
    await applyMockRefundNotify(body.outRefundNo, body.status as 'SUCCESS' | 'CLOSED' | 'ABNORMAL')
    success(res, {})
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/system/pay-mock/calls?op=queryRefund|createRefund
router.get('/calls', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const op = req.query.op as 'queryRefund' | 'createRefund' | undefined
    if (op !== undefined && op !== 'queryRefund' && op !== 'createRefund') throw new AppError(40000, '无效 op', 400)
    success(res, getPayMockCalls(op ?? 'queryRefund'))
  } catch (e) {
    next(e)
  }
})

export default router
