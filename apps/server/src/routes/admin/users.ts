import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { adminIssueLimiter } from '../../middlewares/rate-limit'
import { issueCoupon } from '../../services/member/coupons'

const router = Router()

/** 分页参数的唯一解析处：上限 50，页码下限 1。四个端点口径必须一致 */
function readPage(req: Request): { page: number; pageSize: number } {
  return {
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(50, Math.max(1, Number(req.query.pageSize) || 20)),
  }
}

/** `:id` 的解析 + 存在性校验。三个子端点都要，抽出来免得少写一处就变成「查别人的账」 */
async function requireUser(req: Request): Promise<number> {
  const userId = Number(req.params.id)
  if (!Number.isInteger(userId) || userId <= 0) throw new AppError(40001, '无效的用户 ID')
  const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!exists) throw new AppError(40401, '用户不存在', 404)
  return userId
}

/**
 * 积分流水的中文标签。**在服务端拼而不是丢给前端**：这套 type 字面量已经有三个消费方
 * （后台用户页、小程序积分明细、将来的导出），各写一份 map 必然漂移出三套说法。
 *
 * 未知 type 回落成原字面量而不是「其他」：真出现没见过的类型时，屏幕上直接显示
 * `ADMIN` 比显示「其他」更容易让人查出是谁写进来的。
 */
const LEDGER_TYPE_LABEL: Record<string, string> = {
  EARN: '消费得分',
  REDEEM: '兑换券',
  GIFT: '随单赠品',
  GIFT_REVERT: '取消退回',
  REFUND_DEDUCT: '退款扣回',
  EXPIRE: '过期',
  ADMIN: '手动调整',
}

// GET /api/admin/users — 用户列表（分页 + 昵称/手机号搜索）
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, pageSize } = readPage(req)
    const keyword = (req.query.keyword as string | undefined)?.trim()

    const where = keyword
      ? {
          OR: [{ nickname: { contains: keyword } }, { phone: { contains: keyword } }],
        }
      : {}

    const [list, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          openid: true,
          nickname: true,
          avatarUrl: true,
          phone: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          pointsBalance: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ])

    // 可用券数 = UNUSED 且未到期。**按时间判**而不是只看 status：
    // 过期是定时任务批量翻的，任务没跑到之前那些券还挂着 UNUSED，只看 status 会多算。
    // 一次 groupBy 把本页所有用户数完；在 map 里逐用户 count() 就是每页 20 条 SQL。
    const counts = list.length
      ? await prisma.userCoupon.groupBy({
          by: ['userId'],
          where: { userId: { in: list.map((u) => u.id) }, status: 'UNUSED', expiresAt: { gt: new Date() } },
          _count: { _all: true },
        })
      : []
    const couponsByUser = new Map(counts.map((c) => [c.userId, c._count._all]))

    paginate(
      res,
      list.map(({ _count, ...u }) => ({
        ...u,
        orderCount: _count.orders,
        availableCoupons: couponsByUser.get(u.id) ?? 0,
      })),
      total,
      page,
      pageSize
    )
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/users/:id/orders — 某用户的订单列表
router.get('/:id/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = await requireUser(req)
    const { page, pageSize } = readPage(req)

    const where = { userId }
    const [list, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNo: true,
          status: true,
          actualAmount: true,
          discountAmount: true,
          createdAt: true,
          items: { select: { productName: true, quantity: true, isGift: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ])

    paginate(res, list, total, page, pageSize)
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/users/:id/points-ledger — 积分流水（分页倒序）
router.get('/:id/points-ledger', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = await requireUser(req)
    const { page, pageSize } = readPage(req)

    const where = { userId }
    const [list, total] = await prisma.$transaction([
      prisma.pointsLedger.findMany({
        where,
        select: {
          id: true, type: true, delta: true, balanceAfter: true,
          refType: true, refId: true, remark: true, expiresAt: true, createdAt: true,
        },
        // 按 id 倒序而不是 createdAt：同一事务里写的多条流水（例如 GIFT + EARN）
        // createdAt 可能一模一样，按它排序顺序不稳定，翻页会漏行/重行。
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.pointsLedger.count({ where }),
    ])

    // refType='ORDER' 时 refId 存的是 **Order.id**（见 points.ts 的 `refId: String(order.id)`），
    // 不是 orderNo。店主看的是单号，这里联查一次补上；一次 findMany，不逐行查。
    const orderIds = [...new Set(
      list.filter((r) => r.refType === 'ORDER').map((r) => Number(r.refId)).filter((n) => Number.isInteger(n) && n > 0)
    )]
    const orders = orderIds.length
      ? await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNo: true } })
      : []
    const orderNoById = new Map(orders.map((o) => [o.id, o.orderNo]))

    paginate(
      res,
      list.map((r) => ({
        ...r,
        typeLabel: LEDGER_TYPE_LABEL[r.type] ?? r.type,
        orderNo: r.refType === 'ORDER' ? (orderNoById.get(Number(r.refId)) ?? null) : null,
      })),
      total,
      page,
      pageSize
    )
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/users/:id/coupons?status= — 该用户全部券（含已用/已过期）
//
// 管理端**可以**看 issuedBy / remark，顾客端不行（M1 Task 7 已定）：remark 里写的是
// 「XX 投诉赔偿」这类内部说法，给顾客看等于把内部备注贴到脸上。
router.get('/:id/coupons', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = await requireUser(req)
    const status = typeof req.query.status === 'string' && req.query.status ? String(req.query.status) : undefined

    const list = await prisma.userCoupon.findMany({
      where: { userId, ...(status ? { status } : {}) },
      select: {
        id: true, templateId: true, code: true, name: true, amount: true, threshold: true,
        channel: true, status: true, source: true, sourceRef: true, issuedBy: true, remark: true,
        expiresAt: true, usedAt: true, orderId: true, createdAt: true,
      },
      orderBy: { id: 'desc' },
    })

    // 券上只有 orderId（核销时写入），店主要看的是单号——与流水那边同样的联查
    const orderIds = [...new Set(list.map((c) => c.orderId).filter((v): v is number => v !== null))]
    const orders = orderIds.length
      ? await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNo: true } })
      : []
    const orderNoById = new Map(orders.map((o) => [o.id, o.orderNo]))

    success(res, list.map((c) => ({ ...c, orderNo: c.orderId !== null ? (orderNoById.get(c.orderId) ?? null) : null })))
  } catch (e) {
    next(e)
  }
})

const issueSchema = z.object({
  templateId: z.number().int().positive(),
  // 备注必填：这个端点凭空造出真金白银，「为什么发这张」不写清楚，一个月后没人说得清。
  remark: z.string().trim().min(1, '请填写发放原因').max(255),
  orderNo: z.string().trim().max(64).optional().nullable(),
})

/**
 * POST /api/admin/users/:id/coupons — 店员定向发券（赔偿券走这条路，不是发赔偿积分）。
 *
 * 只认 `source='ADMIN'` 的模板：POINTS/CAMPAIGN 模板带 totalLimit 这类库存语义，
 * 从这里发出去会绕开 `issuedCount` 那道并发防线（本端点不递增它），限量券就变成无限量。
 * NEWCOMER 同理——它靠「每人一张」的查重发放，手动补发会把那条不变式打破。
 */
router.post('/:id/coupons', adminIssueLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = await requireUser(req)
    const body = issueSchema.parse(req.body)

    const template = await prisma.couponTemplate.findUnique({ where: { id: body.templateId } })
    if (!template) throw new AppError(40401, '券模板不存在', 404)
    if (template.source !== 'ADMIN') throw new AppError(40001, '只能发放「手动发放」类型的券模板')
    // 停用返回 42254，与 issueCoupon / redeemByPoints 同一个错误码，前端只认一处文案
    if (template.status !== 'ON') throw new AppError(42254, '该优惠券已停用')

    // orderNo 落到 sourceRef，是「这张券是为哪一单补的」的唯一记录。必须校验归属：
    // 不校验的话，一个笔误的单号会让赔偿记录指到别人的订单上，事后对账全乱。
    let sourceRef: string | null = null
    if (body.orderNo) {
      const order = await prisma.order.findFirst({
        where: { orderNo: body.orderNo },
        select: { id: true, userId: true },
      })
      if (!order || order.userId !== userId) throw new AppError(40001, '订单不属于该用户')
      sourceRef = body.orderNo
    }

    const coupon = await prisma.$transaction((tx) =>
      issueCoupon(tx, {
        userId,
        template,
        source: 'ADMIN',
        sourceRef,
        issuedBy: req.adminUsername ?? null,
        remark: body.remark,
      })
    )
    success(res, coupon)
  } catch (e) {
    next(e)
  }
})

export default router
