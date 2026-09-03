import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { callRider, voidUnknownDelivery } from '../../services/delivery/orchestrator'

const router = Router()

async function doAccept(id: number) {
  const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true, status: true } })
  if (!target) throw new AppError(40401, '订单不存在', 404)
  if (target.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单可在此接单')
  const moved = await prisma.order.updateMany({ where: { id, status: 'PAID' }, data: { status: 'PREPARING', acceptedAt: new Date() } })
  if (moved.count === 0) throw new AppError(42204, `订单状态为 ${target.status}，仅已付款订单可接单`)
  return prisma.order.findUnique({ where: { id } })
}

// POST /api/admin/local/orders/:id/accept — 同城接单（PAID → PREPARING）
router.post('/:id/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    success(res, await doAccept(id))
  } catch (e) { next(e) }
})

// POST /api/admin/local/orders/:id/accept-and-call — 接单成功后立即呼叫骑手；呼叫失败接单保留
router.post('/:id/accept-and-call', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    await doAccept(id)
    try {
      const r = await callRider({ orderId: id, operator: req.adminUsername!, source: 'ADMIN' })
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
    const r = await callRider({ orderId: id, operator: req.adminUsername!, source: 'ADMIN' })
    success(res, r)
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

// GET /api/admin/local/orders/:id/delivery — 有效配送单（无则最近一张）+ 事件时间线
router.get('/:id/delivery', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const delivery = await prisma.delivery.findFirst({
      where: { orderId: id },
      orderBy: { id: 'desc' },
      include: { events: { orderBy: { id: 'asc' } } },
    })
    success(res, { delivery: delivery ?? null, events: delivery?.events ?? [] })
  } catch (e) { next(e) }
})

export default router
