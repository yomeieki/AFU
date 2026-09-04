import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import {
  callRider, voidUnknownDelivery, precancelDelivery, cancelDelivery, addTip, selfDeliver, markDelivered,
} from '../../services/delivery/orchestrator'
import { refreshOrderQuote, kickOffQuote, isQuoteStale } from '../../services/delivery/quote'

const router = Router()

async function doAccept(id: number) {
  const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true, status: true } })
  if (!target) throw new AppError(40401, '订单不存在', 404)
  if (target.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单可在此接单')
  const moved = await prisma.order.updateMany({ where: { id, status: 'PAID' }, data: { status: 'PREPARING', acceptedAt: new Date() } })
  if (moved.count === 0) throw new AppError(42204, `订单状态为 ${target.status}，仅已付款订单可接单`)
  return prisma.order.findUnique({ where: { id } })
}

// 规格 §10：指定运力用具名列表覆盖设置里的默认列表，不做成 oneToOne 布尔值。
// v1 界面不传这个字段，接口先把口子留好。
const callSchema = z.object({ providers: z.array(z.string().trim().min(1).max(32)).min(1).max(10).optional() })

// POST /api/admin/local/orders/:id/accept — 同城接单（PAID → PREPARING）
router.post('/:id/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await doAccept(id)
    // 规格 §6b：转「备餐中」的这一刻后台预取一次六家报价（batchPrice 免费不扣费）。
    // 备餐那十几分钟店员不急，呼叫的那一刻他最急——把查询放在不急的时候做完。
    kickOffQuote(id)
    success(res, order)
  } catch (e) { next(e) }
})

// POST /api/admin/local/orders/:id/accept-and-call — 接单成功后立即呼叫骑手；呼叫失败接单保留
router.post('/:id/accept-and-call', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { providers } = callSchema.parse(req.body ?? {})
    await doAccept(id)
    // 同样预取，但不等它：呼叫要立刻发出去。占位创建时快照多半赶不上（异步查价还没落库），
    // 但外呼本身耗时数秒，成功落库那一刻 orchestrator 会再读一次订单补上（见其注释）——
    // 报价是「锦上添花」，不该让呼叫等它，但也不该白白空着。
    kickOffQuote(id)
    try {
      const r = await callRider({ orderId: id, operator: req.adminUsername!, source: 'ADMIN', providers })
      success(res, { accepted: true, ...r })
    } catch (e) {
      if (e instanceof AppError) e.message = '已接单，' + e.message
      throw e
    }
  } catch (e) { next(e) }
})

// POST /api/admin/local/orders/:id/call — 呼叫骑手
router.post('/:id/call', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { providers } = callSchema.parse(req.body ?? {})
    const r = await callRider({ orderId: id, operator: req.adminUsername!, source: 'ADMIN', providers })
    success(res, r)
  } catch (e) { next(e) }
})

// POST /api/admin/local/orders/:id/quote — 手动重查配送报价（规格 §6b 保鲜第二层：呼叫弹窗上的刷新按钮）
router.post('/:id/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const r = await refreshOrderQuote(id)
    success(res, { snapshot: r.snapshot, quotedAt: r.quotedAt.toISOString(), stale: false, persisted: r.persisted })
  } catch (e) { next(e) }
})

// POST /api/admin/local/orders/:id/delivery/void — 作废「状态未确认」配送单（人工核实快递100 后台无单）
router.post('/:id/delivery/void', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    await voidUnknownDelivery({ orderId: id, operator: req.adminUsername ?? 'admin' })
    success(res, {})
  } catch (e) { next(e) }
})

// GET /api/admin/local/orders/:id/delivery — 有效配送单（无则最近一张）+ 事件时间线 + 当前报价快照
// 报价只走这里和呼叫弹窗，**不上工作台卡片**（规格 §4：卡片只回答该不该现在处理这一单）。
router.get('/:id/delivery', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const [delivery, order] = await Promise.all([
      prisma.delivery.findFirst({
        where: { orderId: id },
        orderBy: { id: 'desc' },
        include: { events: { orderBy: { id: 'asc' } } },
      }),
      prisma.order.findUnique({ where: { id }, select: { quoteSnapshot: true, quotedAt: true } }),
    ])
    success(res, {
      delivery: delivery ?? null,
      events: delivery?.events ?? [],
      // 呼叫弹窗要的那一块：六家报价 + 查询时间 + 是否已过期（>5 分钟转琥珀底并标「已过期」）。
      // stale 在服务端算，免得前端各自复刻一遍阈值。
      quote: order
        ? { snapshot: order.quoteSnapshot ?? null, quotedAt: order.quotedAt?.toISOString() ?? null, stale: isQuoteStale(order.quotedAt) }
        : null,
    })
  } catch (e) { next(e) }
})

// POST /api/admin/local/orders/:id/delivery/precancel — 预估取消费（不真取消）
router.post('/:id/delivery/precancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    success(res, await precancelDelivery(id))
  } catch (e) { next(e) }
})

const cancelSchema = z.object({ reason: z.string().trim().max(255).optional() })
// POST /api/admin/local/orders/:id/delivery/cancel — 取消在途配送单
router.post('/:id/delivery/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { reason } = cancelSchema.parse(req.body ?? {})
    success(res, await cancelDelivery({ orderId: id, operator: req.adminUsername ?? 'admin', reason }))
  } catch (e) { next(e) }
})

const tipSchema = z.object({ amount: z.number().int().min(1).max(100000) })
// POST /api/admin/local/orders/:id/delivery/tip — 加小费
router.post('/:id/delivery/tip', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { amount } = tipSchema.parse(req.body ?? {})
    success(res, await addTip({ orderId: id, amountFen: amount, operator: req.adminUsername ?? 'admin' }))
  } catch (e) { next(e) }
})

const selfDeliverSchema = z.object({
  name: z.string().trim().min(1).max(32),
  phone: z.string().trim().min(5).max(20),
})
// POST /api/admin/local/orders/:id/self-deliver — 店内自送
router.post('/:id/self-deliver', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { name, phone } = selfDeliverSchema.parse(req.body ?? {})
    success(res, await selfDeliver({ orderId: id, name, phone, operator: req.adminUsername ?? 'admin' }))
  } catch (e) { next(e) }
})

// POST /api/admin/local/orders/:id/delivered — 标记已送达
router.post('/:id/delivered', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    await markDelivered({ orderId: id, operator: req.adminUsername ?? 'admin' })
    success(res, {})
  } catch (e) { next(e) }
})

export default router
