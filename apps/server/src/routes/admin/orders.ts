import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { rollbackOrderStock } from '../../utils/order-stock'
import { releaseOrderBenefits } from '../../services/member/checkout'
import { initiateRefund, remainingRefundable } from '../../services/refund'
import { deductPointsOnRefund } from '../../services/member/points'
import { sendShipSubscribeMessage, sendPickupReadySubscribeMessage } from '../../services/subscribe-message'
import { notifySystemAlert } from '../../services/notify'
import { enqueueOrderTicket } from '../../services/ticket'
import { LOW_STOCK_THRESHOLD } from '../../utils/constants'
import { displayAddress } from '../../utils/address'
import { BOOKING_STATUS_LABEL } from '../../services/delivery/express-booking-state'
import { rejectCancelRequest } from '../../services/cancel-request'
import { settlePoints } from '../../services/member/points'
import { parseLocalDayStart, localDayBounds } from '../../utils/local-day'
import { scheduleView } from '../../services/delivery/schedule'
import { getLocalSettings } from '../../services/local-settings'

const router = Router()

const orderListSelect = {
  id: true,
  orderNo: true,
  status: true,
  totalAmount: true,
  shippingFee: true,
  packingFee: true,
  actualAmount: true,
  refundedAmount: true,
  deliveryType: true,
  remark: true,
  tablewareMode: true,
  tablewareCount: true,
  receiverName: true,
  receiverPhone: true,
  receiverFullAddress: true,
  receiverDistrict: true,
  receiverDetail: true,
  paidAt: true,
  acceptedAt: true,
  completedAt: true,
  cancelReason: true,
  createdAt: true,
  distanceM: true,
  cancelRequestedAt: true,
  estimatedDeliveryAt: true,
  pickupAt: true,
  pickupReadyAt: true,
  pickupDiscountAmount: true,
  // 预约送达（2026-09-21）：列表 schedule 筛选与预约单标识要用
  scheduledAt: true,
  readyAt: true,
  prepTicketAt: true,
  promoDiscountAmount: true,
  // 会员优惠（M2）。userId 是 M3「发赔偿券」要用的——发券端点按用户维度，列表里没有它
  // 就得先点进详情再回来，店员在售后场景下最不需要的就是多两次跳转。
  userId: true,
  couponId: true,
  discountAmount: true,
  pointsUsed: true,
  pointsEarned: true,
  items: {
    select: { productName: true, productImage: true, specText: true, quantity: true, productPrice: true, subtotal: true, isGift: true, pointsCost: true },
  },
  shipment: {
    select: { id: true, orderId: true, expressCompany: true, expressNo: true, shippedAt: true, remark: true },
  },
  refunds: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, status: true, outRefundNo: true, amount: true, mode: true, errorMessage: true, createdAt: true },
  },
  afterSales: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, status: true, reason: true, createdAt: true },
  },
  deliveries: {
    orderBy: { id: 'desc' as const },
    take: 1,
    select: { status: true, courierName: true, courierCompany: true, provider: true },
  },
}

const orderDateSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD').optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD').optional(),
})

// GET /api/admin/orders?status=&keyword=（订单号/收货人/手机号模糊）&startDate=&endDate=（上海自然日，按下单时间 createdAt，各自可选）
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const rawStatus = req.query.status as string | undefined
    // REFUND_ATTENTION（2026-09-22）是伪状态：「退款待处理」Tab。含义 = 订单在 REFUNDING，且没有
    // 一笔退款还在微信那边走（PENDING/PROCESSING）——剩下的都是要人出手的：没有退款记录（取消后
    // 迟到付款、自动退款发起前就抛错）、ABNORMAL（去商户平台处理）、CLOSED/FAILED（后台重试）。
    // 正常退款中的单不在这里：自动补查（services/refund-reconcile.ts）会把它们推到结局，店员不用盯。
    // 与 admin 端 utils/order-actions.ts 的 refundNeedsHuman 是同一条规则的服务端版本。
    const refundAttention = rawStatus === 'REFUND_ATTENTION'
    const statuses = rawStatus && !refundAttention ? rawStatus.split(',').filter(Boolean) : []
    const status = statuses.length === 1 ? statuses[0] : undefined
    const attentionWhere: Prisma.OrderWhereInput = refundAttention
      ? { status: 'REFUNDING', refunds: { none: { status: { in: ['PENDING', 'PROCESSING'] } } } }
      : {}
    // keyword 新参数；orderNo 旧参数兼容
    const keyword = ((req.query.keyword as string | undefined) ?? (req.query.orderNo as string | undefined))?.trim()
    // 邮寄订单页默认只看 EXPRESS；同城看板传 LOCAL / PICKUP；channel=LOCAL 一次看外送 + 自取；ALL 不过滤
    const dt = (req.query.deliveryType as string | undefined) ?? 'EXPRESS'
    // F16：非法 channel（拼写错误/前端传了个新值）曾经被 `ch === 'LOCAL'` 悄悄当成「未传」处理，
    // 落回 deliveryType 的默认分支，店员看到的列表跟预期渠道对不上却没有任何报错。改成显式
    // 白名单校验，非法值直接 400，而不是静默退化。
    const ch = req.query.channel ? z.enum(['EXPRESS', 'LOCAL']).parse(req.query.channel) : undefined
    const dtWhere: Prisma.OrderWhereInput = ch === 'LOCAL'
      ? { deliveryType: { in: ['LOCAL', 'PICKUP'] } }
      : ch === 'EXPRESS'
        ? { deliveryType: 'EXPRESS' }
        : dt === 'ALL' ? {} : { deliveryType: dt === 'LOCAL' ? 'LOCAL' : dt === 'PICKUP' ? 'PICKUP' : 'EXPRESS' }

    // 日期筛选：按上海自然日（进程本地时区）解释，缺省 = 不限日期。格式先经 zod，
    // 日历有效性再经 parseLocalDayStart——两者分开校验是为了给「日期无效」与
    // 「开始日期晚于结束日期」两种情形不同的提示文案。
    const { startDate, endDate } = orderDateSchema.parse(req.query)
    if (startDate && !parseLocalDayStart(startDate)) throw new AppError(40001, '日期无效')
    if (endDate && !parseLocalDayStart(endDate)) throw new AppError(40001, '日期无效')
    let createdAtWhere: Prisma.OrderWhereInput = {}
    if (startDate || endDate) {
      let bounds: { gte?: Date; lt?: Date }
      try {
        bounds = localDayBounds(startDate, endDate)
      } catch {
        throw new AppError(40001, '开始日期晚于结束日期')
      }
      createdAtWhere = { createdAt: bounds }
    }

    // 预约 / 尽快筛选（2026-09-21）；不传不过滤
    const sc = req.query.schedule ? z.enum(['SCHEDULED', 'ASAP']).parse(req.query.schedule) : undefined
    const scWhere: Prisma.OrderWhereInput = sc === 'SCHEDULED' ? { scheduledAt: { not: null } } : sc === 'ASAP' ? { scheduledAt: null } : {}

    const where = {
      ...(status ? { status } : statuses.length > 1 ? { status: { in: statuses } } : {}),
      ...attentionWhere,
      ...dtWhere,
      ...createdAtWhere,
      ...scWhere,
      ...(keyword
        ? {
            OR: [
              { orderNo: { contains: keyword } },
              { receiverName: { contains: keyword } },
              { receiverPhone: { contains: keyword } },
            ],
          }
        : {}),
    }

    const [list, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        select: orderListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ])

    paginate(
      res,
      list.map(({ refunds, afterSales, deliveries, ...o }) => ({
        ...o,
        // 同城单展示用短地址（省市恒为门店所在地，是噪音）。规则只在服务端实现一处，
        // 前端直接显示，避免前后端各写一遍后慢慢漂移。receiverFullAddress 保留原样——
        // 「复制收件信息」要粘到别处用，必须完整。
        receiverDisplayAddress: displayAddress(o, o.deliveryType === 'LOCAL' || o.deliveryType === 'PICKUP'),
        latestRefund: refunds[0] ?? null,
        afterSale: afterSales[0] ?? null,
        remainingRefundable: remainingRefundable(o),
        latestDelivery: deliveries[0] ?? null,
      })),
      total,
      page,
      pageSize
    )
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/orders/pending-count — 待处理计数（供后台提醒轮询）
// 注意：必须注册在 GET /:id 之前，否则会被 :id 匹配吞掉
router.get('/pending-count', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [count, latest, refundingCount, lowStockCount, afterSaleCount, localPendingCount] = await Promise.all([
      // 待处理 = 待接单(PAID) + 备餐中(PREPARING)（邮寄铃铛只数邮寄）
      prisma.order.count({ where: { status: { in: ['PAID', 'PREPARING'] }, deliveryType: 'EXPRESS' } }),
      prisma.order.findFirst({
        // 与上面的 count 同口径：邮寄铃铛的「最近一单」不能取到同城单，
        // 否则会出现「0 笔待处理」却带着一个同城单时间戳的矛盾显示。
        where: { status: 'PAID', deliveryType: 'EXPRESS' },
        orderBy: { paidAt: 'desc' },
        select: { paidAt: true, createdAt: true },
      }),
      prisma.order.count({ where: { status: 'REFUNDING' } }),
      prisma.product.count({
        where: { deletedAt: null, status: 'ON_SHELF', stock: { lte: LOW_STOCK_THRESHOLD } },
      }),
      prisma.afterSale.count({ where: { status: 'PENDING' } }),
      prisma.order.count({
        where: {
          deliveryType: { in: ['LOCAL', 'PICKUP'] },
          OR: [
            { status: { in: ['PAID', 'PREPARING'] } },
            // 取消申请徽标只数还没走完流程的单：终态单的 cancelRequestedAt 是历史痕迹，不该永久占一个红点
            { cancelRequestedAt: { not: null }, status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED'] } },
          ],
        },
      }),
    ])
    success(res, {
      count,
      latestPaidAt: latest ? (latest.paidAt ?? latest.createdAt) : null,
      refundingCount,
      lowStockCount,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      afterSaleCount,
      localPendingCount,
    })
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/orders/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: true,
        payment: true,
        shipment: true,
        refunds: { orderBy: { createdAt: 'desc' } },
        afterSales: { orderBy: { createdAt: 'desc' } },
        user: { select: { id: true, nickname: true, phone: true } },
        expressBookings: {
          orderBy: { id: 'desc' as const },
          take: 1,
          select: {
            id: true, bookingNo: true, status: true, kuaidicom: true, kuaidinum: true, dayType: true, pickupDate: true, pickupStart: true, pickupEnd: true,
            courierName: true, courierMobile: true, customerFeeFen: true, quotedFeeFen: true, prepaidFeeFen: true, settledFeeFen: true, billedWeightG: true,
            weightG: true, failReason: true, activeOrderId: true,
          },
        },
      },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    // 券的完整信息（Order.couponId 是普通 Int 列，无关系字段可 include）。
    // 管理端比顾客端多给 source 与 issuedBy：店员在售后场景要能一眼看出
    // 「这张券是谁发的、是不是我们自己补偿出去的」——这直接影响要不要再补一张。
    const coupon = order.couponId
      ? await prisma.userCoupon.findUnique({
          where: { id: order.couponId },
          select: { name: true, code: true, amount: true, threshold: true, source: true, issuedBy: true, remark: true },
        })
      : null
    success(res, {
      ...order,
      coupon,
      receiverDisplayAddress: displayAddress(order, order.deliveryType === 'LOCAL' || order.deliveryType === 'PICKUP'),
      remainingRefundable: remainingRefundable(order),
      // 预约送达（2026-09-21）：非预约单或计算不出（缺距离）为 null，见 scheduleView
      schedule: order.deliveryType === 'LOCAL' && order.scheduledAt ? scheduleView(await getLocalSettings(), order, new Date()) : null,
    })
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/accept — 接单（PAID → PREPARING 备餐中）；自取单也走这里（同城单被下面拒掉，去同城看板专用接单）
router.post('/:id/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true } })
    if (!target) throw new AppError(40401, '订单不存在', 404)
    if (target.deliveryType === 'LOCAL') throw new AppError(42204, '同城订单请在同城看板操作')
    const moved = await prisma.order.updateMany({
      where: { id, status: 'PAID' },
      data: { status: 'PREPARING', acceptedAt: new Date() },
    })
    if (moved.count === 0) {
      const order = await prisma.order.findUnique({ where: { id } })
      if (!order) throw new AppError(40401, '订单不存在', 404)
      throw new AppError(42204, `订单状态为 ${order.status}，仅已付款订单可接单`)
    }
    success(res, await prisma.order.findUnique({ where: { id } }))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/ship — 发货（PAID/PREPARING 订单）
const shipSchema = z.object({
  expressCompany: z.string().trim().min(1, '请填写快递公司').max(64),
  expressNo: z.string().trim().min(1, '请填写快递单号').max(64),
  remark: z.string().max(255).optional(),
})

router.post('/:id/ship', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { expressCompany, expressNo, remark } = shipSchema.parse(req.body)

    const order = await prisma.order.findUnique({
      where: { id },
      include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1 } },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.deliveryType === 'LOCAL') throw new AppError(42204, '同城订单请在同城看板操作')
    if (order.deliveryType === 'PICKUP') throw new AppError(42284, '自取订单没有快递：备好后点「已备好」，顾客取走后点「已取走」')
    if (!['PAID', 'PREPARING'].includes(order.status)) {
      throw new AppError(42204, `订单状态为 ${order.status}，仅待接单/备餐中订单可发货`)
    }
    const activeBooking = await prisma.expressBooking.findFirst({ where: { activeOrderId: id }, select: { status: true } })
    if (activeBooking) throw new AppError(42264, `该订单有取件预约（${BOOKING_STATUS_LABEL[activeBooking.status] ?? activeBooking.status}），请先取消预约再手填单号`)

    const shippedAt = new Date()
    const result = await prisma.$transaction(async (tx) => {
      // 先做带状态守卫的 updateMany 再写 shipment：:214 的状态检查只是事务外快照，
      // 无守卫的 update({where:{id}}) 会把这几十毫秒里刚落库的 REFUNDING/REFUNDED 强行改回 SHIPPED——
      // 钱已经退出去了，单子却显示已发货，货再发一次就是白送。与 accept/complete 两个兄弟端点保持同一范式。
      const moved = await tx.order.updateMany({
        where: { id, status: { in: ['PAID', 'PREPARING'] } },
        data: { status: 'SHIPPED' },
      })
      if (moved.count === 0) {
        const current = await tx.order.findUnique({ where: { id }, select: { status: true } })
        throw new AppError(42204, `订单状态为 ${current?.status ?? '未知'}，仅待接单/备餐中订单可发货`)
      }
      const shipment = await tx.shipment.upsert({
        where: { orderId: id },
        update: { expressCompany, expressNo, remark, shippedAt },
        create: {
          orderId: id,
          orderNo: order.orderNo,
          deliveryType: order.deliveryType,
          expressCompany,
          expressNo,
          remark,
          shippedAt,
        },
      })
      const updated = await tx.order.findUniqueOrThrow({ where: { id } })
      return { shipment, order: updated }
    })

    // 顾客订阅消息（fire-and-forget）
    sendShipSubscribeMessage(order.user.openid, order, result.shipment, order.items[0]?.productName)
    success(res, result)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/complete — 商家标记完成（SHIPPED → COMPLETED；定时任务 N 天后也会自动完成）
router.post('/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true } })
    if (!target) throw new AppError(40401, '订单不存在', 404)
    if (target.deliveryType === 'LOCAL') throw new AppError(42204, '同城订单请在同城看板操作')
    if (target.deliveryType === 'PICKUP') throw new AppError(42284, '自取订单请点「已取走」完成')
    const moved = await prisma.order.updateMany({
      where: { id, status: 'SHIPPED' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    if (moved.count === 0) {
      const order = await prisma.order.findUnique({ where: { id } })
      if (!order) throw new AppError(40401, '订单不存在', 404)
      throw new AppError(42204, `订单状态为 ${order.status}，仅已发货订单可标记完成`)
    }
    success(res, await prisma.order.findUnique({ where: { id } }))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/pickup-ready — 自取「已备好」（PREPARING → SHIPPED，顾客收到取餐提醒）
router.post('/:id/pickup-ready', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await prisma.order.findUnique({
      where: { id },
      include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1 } },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.deliveryType !== 'PICKUP') throw new AppError(42284, '仅自取订单可标记「已备好」')
    const pickupReadyAt = new Date()
    // 状态推进与「视同驳回取消申请」合成一次原子写：分两步的话，中间抛错会留下
    // 「已 SHIPPED 但申请还挂着、重试又被守卫挡住」的半截状态。驳回痕迹字段与
    // services/cancel-request.ts 的 rejectCancelRequest 完全同款（那边是给独立的驳回端点用的）。
    const moved = await prisma.order.updateMany({
      where: { id, status: 'PREPARING', deliveryType: 'PICKUP' },
      data: {
        status: 'SHIPPED', pickupReadyAt,
        ...(order.cancelRequestedAt
          ? {
              cancelRequestedAt: null, cancelRequestNote: null, cancelRequestDeliveryStatus: null, cancelRequestRemindedAt: null,
              cancelRequestRejectedAt: pickupReadyAt, cancelRequestRejectedBy: 'MANUAL',
            }
          : {}),
      },
    })
    if (moved.count === 0) {
      const cur = await prisma.order.findUnique({ where: { id }, select: { status: true } })
      throw new AppError(42204, `订单状态为 ${cur?.status ?? '未知'}，仅备餐中的自取订单可标记已备好`)
    }
    sendPickupReadySubscribeMessage(order.user.openid, order, order.items[0]?.productName)
    success(res, await prisma.order.findUnique({ where: { id } }))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/picked-up — 自取「已取走」（SHIPPED → COMPLETED）
router.post('/:id/picked-up', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true } })
    if (!target) throw new AppError(40401, '订单不存在', 404)
    if (target.deliveryType !== 'PICKUP') throw new AppError(42284, '仅自取订单可标记「已取走」')
    const moved = await prisma.order.updateMany({
      where: { id, status: 'SHIPPED', deliveryType: 'PICKUP' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    if (moved.count === 0) {
      const cur = await prisma.order.findUnique({ where: { id }, select: { status: true } })
      throw new AppError(42204, `订单状态为 ${cur?.status ?? '未知'}，仅「待取餐」的自取订单可标记已取走`)
    }
    void settlePoints(id) // 与顾客确认收货同款：失败由 settleMissedPoints 兜底
    success(res, await prisma.order.findUnique({ where: { id } }))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/cancel-request/approve — 自取：同意取消 = 全额退（没有配送单/预约要撤）
router.post('/:id/cancel-request/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await prisma.order.findUnique({ where: { id } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.deliveryType !== 'PICKUP') throw new AppError(42284, '同城/邮寄订单的取消申请请到各自看板处理')
    if (!order.cancelRequestedAt) throw new AppError(42204, '该订单没有待处理的取消申请')
    const result = await initiateRefund({ orderId: id, amount: remainingRefundable(order), reason: '顾客申请取消', operator: req.adminUsername ?? 'admin' })
    // 与邮寄 approveExpressCancelRequest 同款：退款已发起就清标记，免得工作台同时显示「退款中」和「待处理申请」
    await prisma.order.updateMany({
      where: { id, cancelRequestedAt: { not: null } },
      data: { cancelRequestedAt: null, cancelRequestNote: null, cancelRequestDeliveryStatus: null, cancelRequestRemindedAt: null },
    })
    success(res, result)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/cancel-request/reject — 自取：驳回（同城/邮寄各有自己的路由）
router.post('/:id/cancel-request/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true } })
    if (!target) throw new AppError(40401, '订单不存在', 404)
    if (target.deliveryType !== 'PICKUP') throw new AppError(42284, '同城/邮寄订单的取消申请请到各自看板处理')
    success(res, await rejectCancelRequest(id, 'MANUAL'))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/refund — 退款（全额或部分，微信退款 API 原路退回）
// amount 由操作员在弹窗里手输并二次确认；服务端校验 0 < amount <= 可退余额（见 services/refund.ts）
const refundSchema = z.object({
  amount: z.number().int().positive(),
  reason: z.string().trim().max(80).optional(),
  // 前端一个退款弹窗实例只生成一次、重试复用（见 admin/src/components/RefundDialog.tsx）
  idempotencyKey: z.string().trim().min(8).max(64).optional(),
})

// 幂等：idempotencyKey 透传进 initiateRefund，由它派生确定性 outRefundNo（见 services/refund.ts）。
// 同一 (订单, 金额, 幂等键) 的重试会撞上 Refund.outRefundNo 唯一索引，复用的是微信侧同一笔退款，
// 而不只是本进程内的一个 Promise——不依赖「PM2 单实例 fork」这个前提，多实例/进程重启后一样成立。
// 不带幂等键的调用（e2e 的并发双击、脚本）行为完全不变，仍由 activeOrderId 唯一索引兜底。
router.post('/:id/refund', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { amount, reason, idempotencyKey } = refundSchema.parse(req.body ?? {})
    success(res, await initiateRefund({ orderId: id, amount, reason, operator: req.adminUsername ?? undefined, idempotencyKey }))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/reject — 拒单（两渠道通用，决策 N3/N4）
// 已付款：全额退走 initiateRefund（其内含 42221 在途配送单拦截），终态 REFUNDED；
// 待付款：直接取消 + 回滚库存。拒单原因写 cancelReason，顾客原样可见。
const REJECT_REASONS: Record<string, string> = {
  SOLD_OUT: '菜品售罄', OUT_OF_RANGE: '超出配送范围', PAST_ACCEPT_TIME: '已过接单时间',
  CUSTOMER_CANCEL: '顾客电话要求取消', OTHER: '其他原因',
}
const rejectSchema = z.object({
  reason: z.enum(['SOLD_OUT', 'OUT_OF_RANGE', 'PAST_ACCEPT_TIME', 'CUSTOMER_CANCEL', 'OTHER']),
  note: z.string().trim().max(40).optional(),
  soldOutProductIds: z.array(z.number().int().positive()).max(50).optional(),
})
router.post('/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const body = rejectSchema.parse(req.body ?? {})
    if (body.reason === 'OTHER' && !body.note) throw new AppError(40001, '选「其他原因」时必须填写说明')
    const cancelReason = `商家拒单：${REJECT_REASONS[body.reason]}${body.note ? `（${body.note}）` : ''}`
    const order = await prisma.order.findUnique({ where: { id }, include: { items: true } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (!['PENDING_PAYMENT', 'PAID', 'PREPARING'].includes(order.status)) {
      throw new AppError(42204, `订单状态为 ${order.status}，已出餐/在途订单请走退款或售后`)
    }
    // 勾选必须是本单里的菜——防手滑把无关商品下架
    const inOrder = new Set(order.items.map((it) => it.productId))
    const soldOutIds = [...new Set(body.soldOutProductIds ?? [])]
    if (soldOutIds.some((pid) => !inOrder.has(pid))) throw new AppError(40001, '勾选了不属于本订单的商品')
    if (body.reason === 'SOLD_OUT' && soldOutIds.length === 0) throw new AppError(40001, '选「菜品售罄」时请勾选售罄的菜品')

    let refund: Awaited<ReturnType<typeof initiateRefund>> | null = null
    if (order.status === 'PENDING_PAYMENT') {
      await prisma.$transaction(async (tx) => {
        const moved = await tx.order.updateMany({ where: { id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason } })
        if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新')
        await rollbackOrderStock(tx, order.items)
        // 未支付取消：把券与赠品积分还回去（spec §5.5）。紧跟在 rollbackOrderStock 之后、
        // 且在状态翻转判 count 成功之后——releaseOrderBenefits 的幂等性依赖这个前提。
        await releaseOrderBenefits(tx, order)
      })
    } else {
      refund = await initiateRefund({ orderId: id, amount: remainingRefundable(order), reason: cancelReason, operator: req.adminUsername ?? 'admin' })
      await prisma.order.update({ where: { id }, data: { cancelReason } })
    }
    // 出票（规格 §8b「订单被取消」）：**只有已付款单**要出。付款那一刻已经出过 NEW_ORDER 票、
    // 厨房很可能正在备餐，店员在后台点下拒单后必须当场让后厨收到「别做了」，否则这单会一直做完。
    // 待付款单从没出过接单票，厨房压根不知道有这单，补一张取消票只会让人对着没见过的单号发懵——
    // 所以判断依据是订单状态（用状态推进前的快照 order.status），不是「拒单」这个动作本身。
    //
    // 不等微信退款回调（wechat-notify.ts:312 那条 CANCEL）：回调慢则几分钟、丢了就永远不来，
    // 而「这单不用做了」在拒单落库那一刻就已经成立，与退款到没到账无关——与 orders.ts:622
    // 顾客自助取消同一取舍。回调后来真到了也不会重复出票：CANCEL 的 dedupeKey 固定 seq=0，
    // 第二次落库撞唯一索引被跳过（services/ticket/index.ts:128 注释）。
    //
    // fire-and-forget：打印是旁路。printCancel 关掉、打印机离线、飞鹅云超时，都不该让拒单接口
    // 本身失败——钱已经退了、状态已经翻了，为一张票把 500 抛给店员只会让人以为拒单没成功。
    // printCancel 开关由 enqueueOrderTicket 内部判断（CANCEL_TICKET_DISABLED），这里不重复判。
    if (order.status !== 'PENDING_PAYMENT') {
      enqueueOrderTicket(id, 'CANCEL').catch((err) => {
        console.error('[admin/orders] enqueueOrderTicket 失败（商家拒单）:', (err as Error).message)
      })
    }
    // 售罄联动下架：独立小事务。退款已是既成事实，这里失败只告警不回滚——
    // 不下架的话下一位顾客照样点得到，同样的单会再来一遍（UI 规格 §7）。
    let offShelfCount = 0
    if (soldOutIds.length > 0) {
      try {
        offShelfCount = (await prisma.product.updateMany({ where: { id: { in: soldOutIds }, status: 'ON_SHELF' }, data: { status: 'OFF_SHELF' } })).count
      } catch (e) {
        notifySystemAlert('拒单联动下架失败', [`订单 ${order.orderNo}`, (e as Error).message, `商品：${soldOutIds.join(',')}`], { key: `reject-offshelf:${id}` })
      }
    }
    success(res, { orderId: id, refund, offShelfCount, cancelReason })
  } catch (e) { next(e) }
})

// PUT /api/admin/orders/:id/status — 受限状态流转（当前仅支持取消未付款订单）
const statusSchema = z.object({
  status: z.enum(['CANCELLED']),
})

// ─────────────────────────────────────────────────────────
// PATCH /api/admin/orders/:id/test-flag — 标记/取消标记「测试单」
//
// 联调（快递100 出票、小程序回归）是在**生产服务器**上做的，会在正式库里留下真实测试订单。
// 标上以后所有经营统计都会排除它（口径见 utils/stats-scope.ts 的 REAL_ORDERS）。
//
// 故意**不加** isProduction 守卫：联调恰恰发生在生产环境，挡掉就等于这个功能不存在。
// 鉴权走 admin/index.ts 上的 verifyAdminToken，与其它后台写接口同级。
//
// 只改这一个布尔，不做任何别的副作用（不退款、不改状态、不动库存、不碰 salesCount）。
//
// 回溯性：统计是实时查询而不是每日快照，所以把一张**已经计入过统计**的单标成测试单，
// 历史区间的数字会跟着变小——趋势图上联调那天的柱子会矮下去，总订单数也会减一。
// 这正是我们要的（假峰应该消失），但它意味着「昨天截图里的数字」和「今天再打开」可能对不上，
// 别误判成 bug。取消标记同理，数字会回来。
//
// 因为它会改变经营数据，每次操作都留痕：谁（管理员账号）在什么时候把哪张单标成了什么。
// ─────────────────────────────────────────────────────────
const testFlagSchema = z.object({ isTest: z.boolean() })
router.patch('/:id/test-flag', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { isTest } = testFlagSchema.parse(req.body)

    const order = await prisma.order.findUnique({
      where: { id },
      select: { id: true, orderNo: true, isTest: true, actualAmount: true, createdAt: true },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    if (order.isTest !== isTest) {
      await prisma.order.update({ where: { id }, data: { isTest } })
      const who = req.adminUsername ?? `admin#${req.adminId ?? '?'}`
      const action = isTest ? '标记为测试单（此后不计入统计）' : '取消测试单标记（重新计入统计）'
      console.warn(`[test-flag] ${who} 将订单 ${order.orderNo}(#${id}) ${action}`)
      notifySystemAlert(
        '订单测试标记变更',
        [
          `操作人：${who}`,
          `订单：${order.orderNo}（#${id}，实付 ${(order.actualAmount / 100).toFixed(2)} 元）`,
          `变更：${order.isTest ? '测试单' : '真实单'} → ${isTest ? '测试单' : '真实单'}`,
          '影响：经营统计会回溯性变化（统计是实时查询，非快照）',
        ],
        // 每单每方向各自成键：连着标几单时不希望被限频吞掉，那样就等于没留痕
        { key: `test-flag:${id}:${isTest}` }
      )
    }

    success(res, { id, orderNo: order.orderNo, isTest })
  } catch (e) {
    next(e)
  }
})

router.put('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { status } = statusSchema.parse(req.body)

    const order = await prisma.order.findUnique({ where: { id }, include: { items: true } })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    if (status === 'CANCELLED') {
      if (order.status !== 'PENDING_PAYMENT') {
        throw new AppError(42204, `订单状态为 ${order.status}，仅待付款订单可取消`)
      }
      const updated = await prisma.$transaction(async (tx) => {
        const moved = await tx.order.updateMany({
          where: { id, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: '商家取消' },
        })
        if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新后重试')
        await rollbackOrderStock(tx, order.items)
        // 未支付取消：把券与赠品积分还回去（spec §5.5）。紧跟在 rollbackOrderStock 之后、
        // 且在状态翻转判 count 成功之后——releaseOrderBenefits 的幂等性依赖这个前提。
        await releaseOrderBenefits(tx, order)
        return tx.order.findUniqueOrThrow({ where: { id } })
      })
      return success(res, updated)
    }
  } catch (e) {
    next(e)
  }
})

export default router
