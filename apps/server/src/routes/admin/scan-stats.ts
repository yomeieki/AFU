import { Router, Request, Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { realOrdersSql } from '../../utils/stats-scope'
import { localDayPartsSql, LOCAL_DAY_GROUP_BY, localDayKey, localDayKeyFromParts, parseLocalDayStart } from '../../utils/local-day'

const router = Router()

const rangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

// 解析日期区间：[start 00:00, end 次日 00:00)，默认近 7 天（含今日）
// 日期→瞬时换算经 utils/local-day.ts 的 parseLocalDayStart（与 stats/shared.ts、
// routes/admin/orders.ts 同一实现），不在此处另拼字面量。
function parseRange(query: unknown) {
  const { startDate, endDate } = rangeSchema.parse(query)
  const end = endDate ? parseLocalDayStart(endDate) : new Date(new Date().setHours(0, 0, 0, 0))
  const start = startDate ? parseLocalDayStart(startDate) : null
  if ((endDate && !end) || (startDate && !start)) {
    throw new z.ZodError([{ code: 'custom', path: ['startDate'], message: '日期无效', input: query }])
  }
  const endExclusive = new Date(end as Date)
  endExclusive.setDate(endExclusive.getDate() + 1)
  const resolvedStart =
    start ??
    (() => {
      const d = new Date(end as Date)
      d.setDate(d.getDate() - 6)
      return d
    })()
  return { start: resolvedStart, endExclusive }
}

// GET /api/admin/scan-stats/summary
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { start, endExclusive } = parseRange(req.query)
    const range = { createdAt: { gte: start, lt: endExclusive } }
    const today = new Date(new Date().setHours(0, 0, 0, 0))

    const [totalScans, uniqueRows, todayScans, convOrders] = await Promise.all([
      prisma.scanLog.count({ where: range }),
      // 「独立访客」数的是 **user_id**，不是 openid。
      //
      // ⚠️ 这里原来写的是 `COUNT(DISTINCT openid)`，而 `scan_logs.openid` **从建表起就没有写入点**
      // （140/140 全 NULL，2026-09-06 实测），所以这个卡片从 `20260509073712_init` 起一直显示 0。
      // 0 是个看着完全合理的数（新店本来就可能没人扫），所以没人质疑过——这类「合理的错值」
      // 比报错更难发现。该列已在同批迁移里删掉。
      //
      // 口径写明白：**匿名扫码（user_id 为空）只进 totalScans，不进这个数**。
      // 所以它是「扫过码的登录用户数」，不是「有多少人扫过」。
      prisma.$queryRaw<{ uniq: bigint }[]>`
        SELECT COUNT(DISTINCT user_id) uniq FROM scan_logs
        WHERE created_at >= ${start} AND created_at < ${endExclusive} AND user_id IS NOT NULL`,
      prisma.scanLog.count({ where: { createdAt: { gte: today } } }),
      // 转化（从简，不做严格归因）：区间内扫过码的用户在区间内创建的非取消订单数。
      //
      // ⚠ 分子分母不同源，这是本指标的已知偏差：分子这里排除了测试单（REAL_ORDERS 口径），
      // 而分母 totalScans 来自 scan_logs，那张表没有测试标记，联调时扫的码照样计入。
      // 后果：若联调账号在同一区间内既扫过码又下过测试单，转化率会偏低。
      // 仍然选择排除测试单——一笔联调单本来就不是真实转化，把它算进分子只会让指标更假。
      // 要彻底干净得连扫码侧一起标（ScanLog 已有 source 字段，e2e 就在传 source:"e2e"），
      // 留待需要时再做；在此之前请按 docs/ops-test-orders.md 里的说明理解联调日的这个数。
      prisma.$queryRaw<{ cnt: bigint }[]>`
        SELECT COUNT(DISTINCT o.id) cnt FROM orders o
        WHERE o.created_at >= ${start} AND o.created_at < ${endExclusive}
          AND o.status != 'CANCELLED'
          ${realOrdersSql('o')}
          AND o.user_id IN (
            SELECT DISTINCT user_id FROM scan_logs
            WHERE created_at >= ${start} AND created_at < ${endExclusive} AND user_id IS NOT NULL
          )`,
    ])

    const orders = Number(convOrders[0]?.cnt ?? 0)
    success(res, {
      totalScans,
      uniqueVisitors: Number(uniqueRows[0]?.uniq ?? 0),
      todayScans,
      conversion: {
        scans: totalScans,
        orders,
        rate: totalScans > 0 ? Number((orders / totalScans).toFixed(4)) : null,
      },
    })
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/scan-stats/trend — 按日扫码量（补齐空缺日期为 0）
router.get('/trend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { start, endExclusive } = parseRange(req.query)
    // 分桶按**本地自然日**，实现与为什么见 utils/local-day.ts。
    // 这里原来是 `GROUP BY DATE(created_at)`（UTC 日）配 JS 侧 `getFullYear()`（进程本地日），
    // 两边口径不同——与 stats.ts 的 /trend 曾经是同一个 bug，那边修了、这边没跟着修。
    //
    // ⚠️ 但这里**不能照抄 stats.ts**：那边聚合 COUNT/SUM，跨小时可加；这里的「独立访客」是
    // COUNT(DISTINCT)，**不可加**——同一个人在同一本地日的两个小时里各扫一次，按小时桶相加
    // 会数成 2 个人。所以把 user_id 也放进 GROUP BY，在 JS 侧用 Set 归并。
    //
    // 行数上界 = 不同 (小时, 用户) 组合数 ≤ 扫码总行数；30 天窗口对本店量级是几百行。
    // 量级真涨上来（单日上万扫码）再回来看这一处。
    const rows = await prisma.$queryRaw<
      { y: number; mo: number; d: number; h: number; userId: number | null; scans: bigint }[]
    >`
      SELECT ${localDayPartsSql()}, user_id userId, COUNT(*) scans
      FROM scan_logs
      WHERE created_at >= ${start} AND created_at < ${endExclusive}
      GROUP BY ${LOCAL_DAY_GROUP_BY}, user_id`

    const scansByDay = new Map<string, number>()
    const visitorsByDay = new Map<string, Set<number>>()
    for (const r of rows) {
      const key = localDayKeyFromParts(r)
      scansByDay.set(key, (scansByDay.get(key) ?? 0) + Number(r.scans))
      // 匿名行（user_id 为 NULL）只计扫码次数，不进访客集合——与 summary 同口径
      if (r.userId !== null) {
        const set = visitorsByDay.get(key) ?? new Set<number>()
        set.add(Number(r.userId))
        visitorsByDay.set(key, set)
      }
    }

    const list: { date: string; scans: number; uniqueVisitors: number }[] = []
    for (const d = new Date(start); d < endExclusive; d.setDate(d.getDate() + 1)) {
      const key = localDayKey(d)
      list.push({
        date: key,
        scans: scansByDay.get(key) ?? 0,
        uniqueVisitors: visitorsByDay.get(key)?.size ?? 0,
      })
    }
    success(res, { list })
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/scan-stats/products — 按商品聚合（分页）
router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { start, endExclusive } = parseRange(req.query)
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 10))

    const grouped = await prisma.scanLog.groupBy({
      by: ['productId'],
      where: { createdAt: { gte: start, lt: endExclusive } },
      _count: { _all: true },
      orderBy: { _count: { productId: 'desc' } },
    })

    const total = grouped.length
    const pageRows = grouped.slice((page - 1) * pageSize, page * pageSize)
    const productIds = pageRows.map((g) => g.productId)

    const [products, orderRows] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true },
      }),
      productIds.length
        ? prisma.$queryRaw<{ product_id: number; cnt: bigint }[]>`
            SELECT oi.product_id, COUNT(DISTINCT oi.order_id) cnt
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            WHERE oi.product_id IN (${Prisma.join(productIds)})
            AND o.created_at >= ${start} AND o.created_at < ${endExclusive}
            AND o.status != 'CANCELLED'
            ${realOrdersSql('o')}
            GROUP BY oi.product_id`
        : Promise.resolve([] as { product_id: number; cnt: bigint }[]),
    ])

    const nameById = new Map(products.map((p) => [p.id, p.name]))
    const ordersById = new Map(orderRows.map((r) => [Number(r.product_id), Number(r.cnt)]))

    const list = pageRows.map((g) => {
      const scans = g._count._all
      const orders = ordersById.get(g.productId) ?? 0
      return {
        productId: g.productId,
        productName: nameById.get(g.productId) ?? `#${g.productId}（已删除）`,
        scans,
        orders,
        conversionRate: scans > 0 ? Number((orders / scans).toFixed(4)) : null,
      }
    })

    success(res, { list, total, page, pageSize })
  } catch (e) {
    next(e)
  }
})

export default router
