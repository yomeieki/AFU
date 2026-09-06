import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { initiateRefund, remainingRefundable } from '../../services/refund'
import { AFTER_SALE_REASON_LABEL, AfterSaleReason } from '../../utils/constants'

const router = Router()

const orderSummarySelect = {
  id: true,
  orderNo: true,
  status: true,
  actualAmount: true,
  refundedAmount: true,
  // 售后面板要显示「实付里已经扣过券」——店员按商品原价退款是这条链路上最容易犯的错。
  // totalAmount / shippingFee 是给退款弹窗那行「商品 ¥A − 券 ¥B + 运费 ¥C」用的：
  // 只给券额，店员还是得自己心算实付是怎么来的；三个数摆齐才是可自检的。
  totalAmount: true,
  shippingFee: true,
  discountAmount: true,
  pointsUsed: true,
  receiverName: true,
  receiverPhone: true,
  receiverFullAddress: true,
  completedAt: true,
  items: { select: { productName: true, specText: true, quantity: true, subtotal: true, isGift: true } },
  shipment: { select: { expressCompany: true, expressNo: true, shippedAt: true } },
}

// GET /api/admin/after-sales?status=PENDING|APPROVED|DONE|REJECTED（空=全部）
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const status = (req.query.status as string | undefined)?.trim()
    const where = status ? { status } : {}
    const [list, total] = await prisma.$transaction([
      prisma.afterSale.findMany({
        where,
        include: { order: { select: orderSummarySelect } },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.afterSale.count({ where }),
    ])
    paginate(
      res,
      list.map((a) => ({
        ...a,
        reasonLabel: AFTER_SALE_REASON_LABEL[a.reason as AfterSaleReason] ?? a.reason,
        remainingRefundable: remainingRefundable(a.order),
      })),
      total,
      page,
      pageSize
    )
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/after-sales/:id/approve {amount, reply?} — 同意并按金额退款（部分或全额）
// idempotencyKey：同 orders.ts 的 /refund——这是店员最常用的退款入口，同 10 秒超时后再点一次
// 双退的风险在这里原样存在，走 initiateRefund 里由 idempotencyKey 派生 outRefundNo 那套机制。
const approveSchema = z.object({
  amount: z.number().int().positive(),
  reply: z.string().trim().max(255).optional(),
  idempotencyKey: z.string().trim().min(8).max(64).optional(),
})

router.post('/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { amount, reply, idempotencyKey } = approveSchema.parse(req.body ?? {})
    const afterSale = await prisma.afterSale.findUnique({ where: { id } })
    if (!afterSale) throw new AppError(40401, '售后单不存在', 404)
    if (afterSale.status !== 'PENDING') throw new AppError(42204, `售后单状态为 ${afterSale.status}，仅待处理可同意`)

    const reasonLabel = AFTER_SALE_REASON_LABEL[afterSale.reason as AfterSaleReason] ?? afterSale.reason
    const result = await initiateRefund({
      orderId: afterSale.orderId,
      amount,
      reason: `售后退款（${reasonLabel}）`,
      operator: req.adminUsername ?? undefined,
      afterSaleId: id,
      idempotencyKey,
    })
    // 退款已同步成功（mock / 微信同步 SUCCESS）时 finalizeRefundSuccess 已置 DONE；否则置 APPROVED 等回调
    await prisma.afterSale.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        refundId: result.refund.id,
        reply: reply || null,
        handledBy: req.adminUsername ?? null,
        handledAt: new Date(),
      },
    })
    if (reply) await prisma.afterSale.update({ where: { id }, data: { reply } })
    success(res, { afterSale: await prisma.afterSale.findUnique({ where: { id } }), refund: result.refund, mode: result.mode })
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/after-sales/:id/reject {reply}
const rejectSchema = z.object({ reply: z.string().trim().min(1, '请填写拒绝原因（顾客可见）').max(255) })

router.post('/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { reply } = rejectSchema.parse(req.body ?? {})
    const moved = await prisma.afterSale.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', reply, handledBy: req.adminUsername ?? null, handledAt: new Date() },
    })
    if (moved.count === 0) throw new AppError(42204, '售后单不存在或已处理')
    success(res, await prisma.afterSale.findUnique({ where: { id } }))
  } catch (e) {
    next(e)
  }
})

export default router
