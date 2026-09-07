import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import {
  callRider, voidUnknownDelivery, precancelDelivery, cancelDelivery, addTip, selfDeliver, markDelivered,
} from '../../services/delivery/orchestrator'
import { refreshOrderQuote, kickOffQuote, isQuoteStale } from '../../services/delivery/quote'
import { getCourierLocationByOrder } from '../../services/delivery/courier-location'
import { getLocalSettings, haversineM } from '../../services/local-settings'
import { enqueueOrderTicket } from '../../services/ticket'

const router = Router()

// B6-05：管理端可见的 Delivery 字段白名单——明确剔除 callbackSalt。
// callbackSalt 是 /api/kd/:deliveryNo（未鉴权路由）验签的唯一防线，一旦随整行下发给前端，
// 泄漏面等同于该配送单的回调伪造密钥。参照顾客侧 orders.ts 的 customerDeliveryView：
// 新增字段前先想一遍是不是也该进白名单，而不是让 select 退化成整行 include。
const ADMIN_DELIVERY_SELECT = {
  id: true, orderId: true, orderNo: true, deliveryNo: true, activeOrderId: true,
  provider: true, status: true, statusRank: true, providerStatus: true, statusDesc: true,
  providerTaskId: true, providerOrderId: true,
  courierCompany: true, courierName: true, courierMobile: true,
  quotedFee: true, actualFee: true, quoteSnapshot: true, quotedAt: true, calledProviders: true,
  callStrategy: true, orderFees: true,
  tipFee: true, cancelFee: true, providerDistanceM: true,
  errorCode: true, failReason: true,
  calledAt: true, acceptedAt: true, pickedUpAt: true, deliveredAt: true, cancelledAt: true, cancelReason: true,
  lastCallbackAt: true,
  callTimeoutRemindedAt: true, acceptedStuckRemindedAt: true, deliveringRemindedAt: true, unknownRemindedAt: true,
  operator: true, createdAt: true, updatedAt: true,
} satisfies Prisma.DeliverySelect

async function doAccept(id: number) {
  const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true, status: true } })
  if (!target) throw new AppError(40401, '订单不存在', 404)
  if (target.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单可在此接单')
  const moved = await prisma.order.updateMany({ where: { id, status: 'PAID' }, data: { status: 'PREPARING', acceptedAt: new Date() } })
  if (moved.count === 0) {
    // 竞态文案：上面 :37 早读到的 target.status 到这里可能已经不是真的了——双标签页接单，
    // 或顾客在这几毫秒内自助取消（走 orders.ts 的条件写），都会让 updateMany 落空却仍拿旧值
    // 拼错误，说出「订单状态为 PAID，仅已付款订单可接单」这种自相矛盾的话。重新读一次当前
    // 状态再报：已被接单（PREPARING）明确告诉店员「已被接单」，而不是复述早已过期的 PAID。
    const now = await prisma.order.findUnique({ where: { id }, select: { status: true } })
    const cur = now?.status ?? target.status
    throw new AppError(42204, cur === 'PREPARING' ? '订单已被接单，请刷新查看' : `订单状态为 ${cur}，仅已付款订单可接单`)
  }
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

// POST /api/admin/local/orders/:id/cancel-request/reject — 驳回顾客的取消申请
// cancelRequestedAt 是 callRider 与 autoCallRiders/refreshStaleQuotes/remindLocalUncalled 的硬性拦截条件，
// 而此前全仓只有写入没有清除：顾客点过一次「申请取消」又改主意（电话说还是要），店家不想退款就只剩「自己送」。
// 驳回就是把这组标记清回 null，让呼叫链路重新放行；同意取消走原有的「取消配送 + 退款」，不在这里。
router.post('/:id/cancel-request/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true, status: true, cancelRequestedAt: true } })
    if (!target) throw new AppError(40401, '订单不存在', 404)
    if (target.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单有取消申请')
    // 终态/退款中的单上这个标记只是历史痕迹（徽标口径同 workbench.ts），不该再被「驳回」改写
    const moved = await prisma.order.updateMany({
      where: { id, cancelRequestedAt: { not: null }, status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED', 'REFUNDING'] } },
      data: { cancelRequestedAt: null, cancelRequestNote: null, cancelRequestDeliveryStatus: null, cancelRequestRemindedAt: null },
    })
    if (moved.count === 0) {
      throw new AppError(42204, target.cancelRequestedAt ? `订单状态为 ${target.status}，取消申请已无需处理` : '该订单没有待处理的取消申请')
    }
    // H6：驳回意味着顾客还是要这一单，厨房该继续做——出一张 RESUME 票提醒。seq 用当次驳回时间戳
    // （不是固定 0）：这个 kind 专门对应"驳回"这个动作本身，每次驳回都该是新的一张，不与任何
    // 其它 RESUME 共享 dedupe 槽位。
    enqueueOrderTicket(id, 'RESUME', { seq: Date.now() }).catch((err) => {
      console.error('[admin/delivery] enqueueOrderTicket 失败（驳回取消申请）:', (err as Error).message)
    })
    success(res, await prisma.order.findUnique({ where: { id } }))
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
    const [delivery, order, allOfOrder] = await Promise.all([
      prisma.delivery.findFirst({
        where: { orderId: id },
        orderBy: { id: 'desc' },
        select: { ...ADMIN_DELIVERY_SELECT, events: { orderBy: { id: 'asc' } } },
      }),
      prisma.order.findUnique({ where: { id }, select: { quoteSnapshot: true, quotedAt: true } }),
      // 这一单**所有**配送单，不只最近一张：自动升级会留下一张 CANCELLED 的 D-1，
      // 它身上的取消费也是店家真花出去的钱。只看最近一张会把这笔漏掉。
      prisma.delivery.findMany({ where: { orderId: id }, select: { status: true, quotedFee: true, actualFee: true, tipFee: true, cancelFee: true } }),
    ])
    // 配送成本口径（前端与退款弹窗共用这一个数，不要各算各的）：
    //
    // ⚠️ **已取消/已失败的配送单，预扣是被释放掉的，一分钱没花**——只有 cancelFee 是真扣的。
    // 小费同理随取消退回（见 orchestrator 的升级说明）。把它们的 quotedFee 也累加进来，
    // 会让每一张自动升级过的单都虚报一大笔：实测订单 19430 的 D-1 是
    // CANCELLED/quoted_fee=1623/cancel_fee=0（真实 ¥0），D-2 实扣 ¥5.00，
    // 全加起来会算成 ¥21.23，是真实成本的 4 倍——而这个数正是店员决定退多少钱时看的。
    //
    // 在途单取 quotedFee 是「已被冻结、大概率会扣掉」的最好估计；中标运力接单后
    // 回调会认领 actualFee（callback.ts），那时就有确切数了。
    const costFen = allOfOrder.reduce((sum, d) => {
      const released = d.status === 'CANCELLED' || d.status === 'FAILED'
      return sum + (released ? 0 : (d.actualFee ?? d.quotedFee ?? 0) + d.tipFee) + d.cancelFee
    }, 0)
    success(res, {
      delivery: delivery ?? null,
      events: delivery?.events ?? [],
      costFen,
      // 呼叫弹窗要的那一块：六家报价 + 查询时间 + 是否已过期（>5 分钟转琥珀底并标「已过期」）。
      // stale 在服务端算，免得前端各自复刻一遍阈值。
      quote: order
        ? { snapshot: order.quoteSnapshot ?? null, quotedAt: order.quotedAt?.toISOString() ?? null, stale: isQuoteStale(order.quotedAt) }
        : null,
    })
  } catch (e) { next(e) }
})

// GET /api/admin/local/orders/:id/courier — 骑手实时位置 + 距离/ETA（管理端）
//
// 首单排查时发现的倒挂：queryCourier 只接到了顾客端，管理端一处都没接——店员站在店里
// 不知道骑手到哪了，只能打电话问。取数与 20 秒缓存与顾客端共用（courier-location.ts），
// 这里多算三个店员真正要的量：距店多远、距顾客多远、大概还要几分钟。
//
// 坐标系：queryCourier 已经确认返回 lbsType=2（GCJ-02，2026-09-06 首单首次验证），
// 与收货坐标（wx.chooseLocation，也是 GCJ-02）同系，可直接算距离，不需要转换。
// 距离用 haversine × detourFactor 估——运力方不提供「骑手到目的地的道路距离」，
// 这里给的是个量级，文案上必须写「约」，不能让店员当成精确值去答复顾客。
router.get('/:id/courier', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const [{ location, fetchedAt, delivery }, order, s] = await Promise.all([
      getCourierLocationByOrder(id),
      prisma.order.findUnique({ where: { id }, select: { receiverLatE6: true, receiverLngE6: true } }),
      getLocalSettings(),
    ])
    if (!location || !delivery) {
      success(res, { location: null, fetchedAt, toStoreM: null, toReceiverM: null, etaMinutes: null, phase: null })
      return
    }
    const detour = (m: number) => Math.round(m * s.detourFactor)
    const toStoreM = s.store.latE6 !== null && s.store.lngE6 !== null
      ? detour(haversineM(location.latE6, location.lngE6, s.store.latE6, s.store.lngE6)) : null
    const toReceiverM = order?.receiverLatE6 != null && order?.receiverLngE6 != null
      ? detour(haversineM(location.latE6, location.lngE6, order.receiverLatE6, order.receiverLngE6)) : null
    // 取货之前看「还有多久到店」，取货之后看「还有多久到顾客」——店员这两个阶段问的不是同一件事
    const phase = delivery.status === 'DELIVERING' ? 'TO_RECEIVER' : 'TO_STORE'
    const legM = phase === 'TO_RECEIVER' ? toReceiverM : toStoreM
    const etaMinutes = legM === null ? null : Math.max(1, Math.round((legM / 1000 / s.riderSpeedKmh) * 60))
    success(res, { location, fetchedAt, toStoreM, toReceiverM, etaMinutes, phase })
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
