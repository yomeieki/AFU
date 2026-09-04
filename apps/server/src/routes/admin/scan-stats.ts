import { Router, Request, Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { realOrdersSql } from '../../utils/stats-scope'

const router = Router()

const rangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

// 解析日期区间：[start 00:00, end 次日 00:00)，默认近 7 天（含今日）
function parseRange(query: unknown) {
  const { startDate, endDate } = rangeSchema.parse(query)
  const end = endDate ? new Date(`${endDate}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0))
  const endExclusive = new Date(end)
  endExclusive.setDate(endExclusive.getDate() + 1)
  const start = startDate
    ? new Date(`${startDate}T00:00:00`)
    : (() => {
        const d = new Date(end)
        d.setDate(d.getDate() - 6)
        return d
      })()
  return { start, endExclusive }
}

function fmtDate(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// GET /api/admin/scan-stats/summary
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { start, endExclusive } = parseRange(req.query)
    const range = { createdAt: { gte: start, lt: endExclusive } }
    const today = new Date(new Date().setHours(0, 0, 0, 0))

    const [totalScans, uniqueRows, todayScans, convOrders] = await Promise.all([
      prisma.scanLog.count({ where: range }),
      prisma.$queryRaw<{ uniq: bigint }[]>`
        SELECT COUNT(DISTINCT openid) uniq FROM scan_logs
        WHERE created_at >= ${start} AND created_at < ${endExclusive} AND openid IS NOT NULL`,
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
      uniqueOpenids: Number(uniqueRows[0]?.uniq ?? 0),
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
    const rows = await prisma.$queryRaw<{ d: Date; scans: bigint; uniq: bigint }[]>`
      SELECT DATE(created_at) d, COUNT(*) scans, COUNT(DISTINCT openid) uniq
      FROM scan_logs
      WHERE created_at >= ${start} AND created_at < ${endExclusive}
      GROUP BY d ORDER BY d`

    const byDate = new Map(rows.map((r) => [fmtDate(new Date(r.d)), r]))
    const list: { date: string; scans: number; uniqueOpenids: number }[] = []
    for (const d = new Date(start); d < endExclusive; d.setDate(d.getDate() + 1)) {
      const key = fmtDate(d)
      const row = byDate.get(key)
      list.push({
        date: key,
        scans: Number(row?.scans ?? 0),
        uniqueOpenids: Number(row?.uniq ?? 0),
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
