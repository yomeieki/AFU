import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { COURIER_LABEL, EXPRESS_COURIERS } from '../../services/express-settings'
import { getBookingQuotes, createBooking, cancelBooking, modifyBookingSlot, voidUnknownBooking, getActiveBooking, bookingView, suggestSlot, SlotInput } from '../../services/delivery/express-booking'

const router = Router()
const slotSchema = z.object({ dayType: z.enum(['今天', '明天', '后天']), pickupStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), pickupEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional() })
const bookSchema = slotSchema.extend({
  kuaidicom: z.string().min(1).max(32), serviceType: z.string().max(32).nullable().optional(),
  weightKg: z.number().min(0.1).max(50).optional(), remark: z.string().max(64).nullable().optional(),
})
const toSlot = (b: z.infer<typeof slotSchema>): SlotInput => ({ dayType: b.dayType, pickupStart: b.pickupStart ?? null, pickupEnd: b.pickupEnd ?? null })
const idOf = (req: Request): number => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) throw new AppError(40001, '订单 id 非法')
  return id
}

// GET /api/admin/express/orders/:id/booking — 最近一条预约 + 是否活跃 + 事件
router.get('/:id/booking', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = idOf(req)
    const b = await prisma.expressBooking.findFirst({ where: { orderId: id }, orderBy: { id: 'desc' }, include: { events: { orderBy: { createdAt: 'asc' }, select: { id: true, source: true, providerStatus: true, statusDesc: true, courierName: true, operator: true, createdAt: true } } } })
    success(res, { booking: b ? bookingView(b) : null, active: !!b && b.activeOrderId === id, events: b?.events ?? [] })
  } catch (e) { next(e) }
})
// GET /api/admin/express/orders/:id/quotes?weightKg=1.5 — 预约弹窗用
router.get('/:id/quotes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = idOf(req)
    const w = req.query.weightKg !== undefined ? Number(req.query.weightKg) : undefined
    if (w !== undefined && !(w >= 0.1 && w <= 50)) throw new AppError(40001, '重量需在 0.1–50 kg')
    const q = await getBookingQuotes(id, w)
    success(res, { ...q, suggestedSlot: suggestSlot(), couriers: EXPRESS_COURIERS.map((c) => ({ code: c, label: COURIER_LABEL[c] })) })
  } catch (e) { next(e) }
})
router.post('/:id/book', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = idOf(req)
    const b = bookSchema.parse(req.body ?? {})
    success(res, await createBooking({ orderId: id, kuaidicom: b.kuaidicom, serviceType: b.serviceType ?? null, weightKg: b.weightKg, slot: toSlot(b), remark: b.remark ?? null, operator: req.adminUsername ?? 'admin' }))
  } catch (e) { next(e) }
})
router.post('/:id/booking/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = idOf(req)
    const { reason } = z.object({ reason: z.string().max(30).optional() }).parse(req.body ?? {})
    await cancelBooking({ orderId: id, operator: req.adminUsername ?? 'admin', reason, by: 'STAFF' })
    success(res, {})
  } catch (e) { next(e) }
})
router.post('/:id/booking/modify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = idOf(req)
    await modifyBookingSlot({ orderId: id, slot: toSlot(slotSchema.parse(req.body ?? {})), operator: req.adminUsername ?? 'admin' })
    success(res, {})
  } catch (e) { next(e) }
})
router.post('/:id/booking/void', async (req: Request, res: Response, next: NextFunction) => {
  try { await voidUnknownBooking({ orderId: idOf(req), operator: req.adminUsername ?? 'admin' }); success(res, {}) } catch (e) { next(e) }
})
export default router
