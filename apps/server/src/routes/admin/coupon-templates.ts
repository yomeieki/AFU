/**
 * 券模板管理（服务端；页面在 M3）。
 *
 * **没有 DELETE**：spec 只有「停用」。已发出去的 UserCoupon 带四个快照字段
 * （name/amount/threshold/channel），模板停用或改价都不影响顾客手里那张券；
 * 但删掉模板会让 UserCoupon.templateId 悬空、发放记录也查不出来源，得不偿失。
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'

const router = Router()

// 上限沿用 admin/settings.ts「挡住把元当分填」的思路：面额上限 1000 元、门槛上限 10 万元。
// 填错一个数量级在券上就是真金白银——顺手多打两个 0 的「满 5 减 1000」比拼错字危险得多。
const baseSchema = z.object({
  name: z.string().trim().min(1, '请填写券名').max(64),
  description: z.string().trim().max(255).optional().nullable(),
  amount: z.number().int().min(1, '面额至少 1 分').max(100000, '面额上限 ¥1000（注意单位是分）'),
  threshold: z.number().int().min(0).max(10000000, '门槛上限 ¥100000（注意单位是分）').default(0),
  channel: z.enum(['ALL', 'LOCAL', 'EXPRESS']).default('ALL'),
  validDays: z.number().int().min(1).max(3650),
  pointsCost: z.number().int().min(1).max(100000000).optional().nullable(),
  totalLimit: z.number().int().min(1).max(1000000).optional().nullable(),
  perUserLimit: z.number().int().min(1).max(1000).optional().nullable(),
  sortOrder: z.number().int().min(-9999).max(9999).default(0),
  status: z.enum(['ON', 'OFF']).default('ON'),
})

const createSchema = baseSchema.extend({
  source: z.enum(['ADMIN', 'POINTS', 'CAMPAIGN', 'NEWCOMER']),
})
// source 不可改：它决定这张模板的发放路径（积分兑 / 领券中心 / 定向发放 / 新人礼），
// 改了会让**已经发出去的券**的 source 与模板对不上，发放记录的口径就断了。
const updateSchema = baseSchema.partial()

/** `source=POINTS` 必须有 pointsCost——没有它「积分兑换」这条路根本走不通（redeemByPoints 会拒） */
function assertPointsCost(source: string, pointsCost: number | null | undefined) {
  if (source === 'POINTS' && (pointsCost === null || pointsCost === undefined)) {
    throw new AppError(40001, '积分兑换券必须填写所需积分')
  }
}

// GET /api/admin/coupon-templates?source=&status=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = typeof req.query.source === 'string' && req.query.source ? String(req.query.source) : undefined
    const status = typeof req.query.status === 'string' && req.query.status ? String(req.query.status) : undefined
    const list = await prisma.couponTemplate.findMany({
      where: { ...(source ? { source } : {}), ...(status ? { status } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { id: 'desc' }],
    })
    // usedCount = 该模板已被**核销**的张数（不是已发放数——issuedCount 是发放数，模板上就有）。
    // 一次 groupBy 数完，不要在 map 里逐张模板查（N+1）。
    const used = list.length
      ? await prisma.userCoupon.groupBy({
          by: ['templateId'],
          where: { templateId: { in: list.map((t) => t.id) }, status: 'USED' },
          _count: { _all: true },
        })
      : []
    const usedByTemplate = new Map(used.map((u) => [u.templateId, u._count._all]))
    success(res, list.map((t) => ({ ...t, usedCount: usedByTemplate.get(t.id) ?? 0 })))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/coupon-templates
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createSchema.parse(req.body)
    assertPointsCost(data.source, data.pointsCost)
    success(res, await prisma.couponTemplate.create({ data }))
  } catch (e) {
    next(e)
  }
})

// PUT /api/admin/coupon-templates/:id — source 不可改（见 updateSchema 注释）
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new AppError(40001, '无效的模板 ID')
    const data = updateSchema.parse(req.body)
    const current = await prisma.couponTemplate.findUnique({ where: { id } })
    if (!current) throw new AppError(40401, '券模板不存在', 404)
    // 用改后的值判：把一张 POINTS 券的 pointsCost 清成 null 同样要拦下来
    assertPointsCost(current.source, 'pointsCost' in data ? data.pointsCost : current.pointsCost)
    success(res, await prisma.couponTemplate.update({ where: { id }, data }))
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/coupon-templates/:id/issued?page= — 发放记录（谁领了、谁发的、为什么发）
router.get('/:id/issued', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new AppError(40001, '无效的模板 ID')
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
    const [total, list] = await Promise.all([
      prisma.userCoupon.count({ where: { templateId: id } }),
      prisma.userCoupon.findMany({
        where: { templateId: id },
        select: {
          id: true, code: true, status: true, source: true, issuedBy: true, remark: true,
          sourceRef: true, expiresAt: true, usedAt: true, orderId: true, createdAt: true,
          user: { select: { id: true, nickname: true } },
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    success(res, { list, total, page, pageSize })
  } catch (e) {
    next(e)
  }
})

export default router
