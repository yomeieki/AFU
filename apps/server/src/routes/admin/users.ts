import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { adminIssueLimiter } from '../../middlewares/rate-limit'
import { issueCoupon } from '../../services/member/coupons'
// 中文标签只有一份（services/member/points.ts）。这里曾经另建过一份，
// 两份当场就不一致（REDEEM 一边「积分兑换」一边「兑换券」）——别再复制。
import { LEDGER_TYPE_LABEL } from '../../services/member/points'

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

interface LatestOrder {
  orderNo: string
  receiverName: string
  receiverPhone: string
  status: string
  createdAt: Date
}

/**
 * 批量取「本页每个用户的最近一单」（createdAt 最新，不排除任何状态）——唯一实现，别改回
 * Prisma 的嵌套关系 select 加一个「限定条数」参数那种写法。
 *
 * 2026-09-22 复核发现：Prisma 5.22 对 MySQL 的默认关系加载策略**不会**把嵌套的「每个父行限定
 * 条数」下推成 LIMIT/窗口函数，而是一条 `WHERE user_id IN (本页 id)` 把这批用户名下的**全部
 * 历史订单**都搬回 Node 层，裁剪在客户端做——语句数是 O(1) 没错，但返回行数随这批用户的历史
 * 订单总量线性增长（实测 21 用户/248 单的库，16 个用户一页能拉回 248 行）。改用下面这条窗口
 * 函数查询，一条 SQL、返回行数恒等于 min(本页用户数, 有订单的用户数)。
 */
async function latestOrderByUserIds(userIds: number[]): Promise<Map<number, LatestOrder>> {
  if (userIds.length === 0) return new Map() // Prisma.join([]) 对空数组会抛错，必须提前短路

  const rows = await prisma.$queryRaw<
    { userId: number; orderNo: string; receiverName: string; receiverPhone: string; status: string; createdAt: Date }[]
  >(Prisma.sql`
    SELECT user_id AS userId, order_no AS orderNo, receiver_name AS receiverName,
           receiver_phone AS receiverPhone, status, created_at AS createdAt
    FROM (
      SELECT o.user_id, o.order_no, o.receiver_name, o.receiver_phone, o.status, o.created_at,
             ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY o.created_at DESC, o.id DESC) AS rn
      FROM orders o
      WHERE o.user_id IN (${Prisma.join(userIds)})
    ) t
    WHERE t.rn = 1
  `)

  return new Map(rows.map(({ userId, ...o }) => [userId, o]))
}


// GET /api/admin/users — 用户列表（分页 + 昵称/手机号/订单收货人搜索 + 只看下过单的）
//
// users.phone/nickname/avatarUrl 从登录起就没被写入过（登录只建 openid 行，见 routes/auth.ts），
// 所以「手机号」列长期全是「-」，店主没法用它锁定顾客。真正有值的是订单快照
// orders.receiverName/receiverPhone。这里不改小程序、不接微信手机号授权，改成：
// 搜索同时匹配这两处；列表附带每个用户「最近一单」的收货人姓名/手机号供前端兜底展示。
//
// 「最近一单」= createdAt 最新的一条，**不排除任何状态**（含未付款、已取消、测试单）——
// 店主要的是「这串号码最近打给谁用过」，不是「最近一笔成交」，付款状态在这里不重要。
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, pageSize } = readPage(req)
    const keyword = (req.query.keyword as string | undefined)?.trim()
    // 只认字面量 '1'；不传或传别的值都不过滤，保持 §48 e2e 的既有假设（默认列出全部用户）。
    const hasOrders = req.query.hasOrders === '1'

    const where = {
      ...(keyword
        ? {
            OR: [
              { nickname: { contains: keyword } },
              { phone: { contains: keyword } },
              // 尾号模糊搜索：contains 天然支持子串匹配，不需要额外处理。
              { orders: { some: { OR: [{ receiverName: { contains: keyword } }, { receiverPhone: { contains: keyword } }] } } },
            ],
          }
        : {}),
      ...(hasOrders ? { orders: { some: {} } } : {}),
    }

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
    const latestOrderByUser = await latestOrderByUserIds(list.map((u) => u.id))

    paginate(
      res,
      list.map(({ _count, ...u }) => ({
        ...u,
        orderCount: _count.orders,
        availableCoupons: couponsByUser.get(u.id) ?? 0,
        latestOrder: latestOrderByUser.get(u.id) ?? null,
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
