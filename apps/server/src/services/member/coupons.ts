/**
 * 优惠券生命周期：发放（四条来源）/ 过期 / 查询 的唯一实现。
 * 设计依据：docs/superpowers/specs/2026-09-04-member-points-coupon-design.md §5.6。
 */
import { Prisma, CouponTemplate } from '@prisma/client'
import prisma from '../../utils/prisma'
import { AppError } from '../../middlewares/error'
import { consumePoints } from './points'
import { getMemberSettings } from './settings'

function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

// ─────────────────────────────────────────────────────────
// code 生成（纯函数，selftest-member.ts 覆盖）
// ─────────────────────────────────────────────────────────

// Crockford base32：排除易混淆的 I/L/O/U，人工报单号时不会读错
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateCouponCode(): string {
  let s = ''
  for (let i = 0; i < 8; i++) {
    s += CROCKFORD_ALPHABET[Math.floor(Math.random() * CROCKFORD_ALPHABET.length)]
  }
  return `C${s}`
}

// ─────────────────────────────────────────────────────────
// 公共发放函数
// ─────────────────────────────────────────────────────────

export interface IssueCouponInput {
  userId: number
  template: Pick<CouponTemplate, 'id' | 'name' | 'amount' | 'threshold' | 'channel' | 'validDays' | 'status' | 'source'>
  /** 记录到 UserCoupon.source（四条来源各自传各自的字面量，不从 template.source 派生，
   *  两者理应相同，显式传入是为了在调用点就能一眼看出这张券是从哪条路径发出的） */
  source: string
  sourceRef?: string | null
  issuedBy?: string | null
  remark?: string | null
}

/**
 * 生成 code、快照四个展示字段、写入 UserCoupon。code 唯一冲突重试 3 次。
 * 模板 status='OFF' 直接拒绝——只挡再发放，已发的券不受影响。
 * 必须在调用方的事务 tx 内执行。
 */
export async function issueCoupon(tx: Prisma.TransactionClient, input: IssueCouponInput) {
  const { userId, template, source, sourceRef, issuedBy, remark } = input
  if (template.status === 'OFF') throw new AppError(42254, '该优惠券已停用')

  const expiresAt = new Date(Date.now() + template.validDays * 24 * 60 * 60 * 1000)
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCouponCode()
    try {
      return await tx.userCoupon.create({
        data: {
          userId,
          templateId: template.id,
          code,
          name: template.name,
          amount: template.amount,
          threshold: template.threshold,
          channel: template.channel,
          status: 'UNUSED',
          source,
          sourceRef: sourceRef ?? null,
          issuedBy: issuedBy ?? null,
          remark: remark ?? null,
          expiresAt,
        },
      })
    } catch (e) {
      if (isUniqueConflict(e)) {
        lastErr = e
        continue // code 撞了唯一索引，换一个再试
      }
      throw e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('生成优惠券编码连续冲突（超过重试次数）')
}

// ─────────────────────────────────────────────────────────
// 四条发放路径
// ─────────────────────────────────────────────────────────

/**
 * 积分兑换。顺序很关键：先发券拿到 id，再调 consumePoints 扣分——
 * consumePoints 会自己写一条 REDEEM 流水，refId 需要是券的 id，
 * 而 id 只有券已经建出来才有；两者同事务，扣分失败会连券一起回滚。
 *
 * 并发安全：事务第一句锁模板行（`FOR UPDATE`），后续 perUserLimit 的 count()、
 * totalLimit 的递增判 count 才是串行化之后的值——否则同一用户 5 个并发请求，
 * `count()` 都读到同一个旧快照，5 个都会通过校验（已在 e2e.d/42 里实测复现：
 * 不加锁时同一用户并发兑换要么全部得逞，要么互相死锁，返回一堆 50001）。
 * `totalLimit` 的 updateMany 写法照抄 claimCampaign——之前完全没有这道防线，
 * M3 后台一旦对 POINTS 模板放开 totalLimit 字段就是「限量兑换品无限兑换」。
 */
export async function redeemByPoints(userId: number, templateId: number) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM coupon_templates WHERE id = ${templateId} FOR UPDATE`
    const template = await tx.couponTemplate.findUnique({ where: { id: templateId } })
    if (!template) throw new AppError(42251, '优惠券不存在')
    if (template.source !== 'POINTS' || template.pointsCost == null || template.pointsCost <= 0) {
      throw new AppError(42251, '该券不支持积分兑换')
    }
    // 停用要精确返回 42254（既有行为，e2e.sh:1587 断言），必须在下面 totalLimit 的
    // updateMany 之前判——那道 where 也带 status:'ON'，OFF 模板会先撞在那里，
    // 拿到含混的「已领完或已停用」42253，把 42254 这个更具体的错误码盖掉。
    if (template.status === 'OFF') throw new AppError(42254, '该优惠券已停用')
    if (template.perUserLimit != null) {
      const already = await tx.userCoupon.count({ where: { userId, templateId, source: 'POINTS' } })
      if (already >= template.perUserLimit) throw new AppError(42253, '已达每人限领数量')
    }
    const moved = await tx.couponTemplate.updateMany({
      where: {
        id: templateId,
        status: 'ON',
        ...(template.totalLimit != null ? { issuedCount: { lt: template.totalLimit } } : {}),
      },
      data: { issuedCount: { increment: 1 } },
    })
    if (moved.count === 0) throw new AppError(42253, '已达兑换总量上限')
    const coupon = await issueCoupon(tx, { userId, template, source: 'POINTS', sourceRef: null, issuedBy: null, remark: null })
    await consumePoints(tx, userId, template.pointsCost, {
      type: 'REDEEM',
      refType: 'COUPON',
      refId: String(coupon.id),
      remark: `兑换优惠券：${template.name}`,
    })
    return coupon
  })
}

/**
 * 领券中心。事务第一句锁模板行（`FOR UPDATE`）：MySQL RR 下这是一次锁定读，会读到
 * 最新已提交的行并等其他并发事务提交/回滚，之后本事务内的普通 SELECT（perUserLimit
 * 的 count()）用的快照也随之推进到「串行化之后」的状态——不加这一句时，同一用户的
 * 5 个并发请求会各自在事务开始时刻建立快照，`count()` 全部读到同一个旧值，全部通过
 * 校验（旧实现的实际后果，已用 e2e.d/42 的 B4-1 实测复现：totalLimit=null 时
 * updateMany 的 where 压根没有数量条件，5 个并发请求 5 个都成功）。
 * totalLimit 用 updateMany 条件递增判 count 做并发防线（限量券不超发）；
 * perUserLimit 用已发数判定——两者是不同维度的限制，可以同时生效。
 */
export async function claimCampaign(userId: number, templateId: number) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM coupon_templates WHERE id = ${templateId} FOR UPDATE`
    const template = await tx.couponTemplate.findUnique({ where: { id: templateId } })
    if (!template || template.source !== 'CAMPAIGN') throw new AppError(42251, '优惠券不存在')
    if (template.perUserLimit != null) {
      const already = await tx.userCoupon.count({ where: { userId, templateId, source: 'CAMPAIGN' } })
      if (already >= template.perUserLimit) throw new AppError(42253, '已达每人限领数量')
    }
    const moved = await tx.couponTemplate.updateMany({
      where: {
        id: templateId,
        status: 'ON',
        ...(template.totalLimit != null ? { issuedCount: { lt: template.totalLimit } } : {}),
      },
      data: { issuedCount: { increment: 1 } },
    })
    if (moved.count === 0) throw new AppError(42253, '该券已领完或已停用')
    return issueCoupon(tx, { userId, template, source: 'CAMPAIGN', sourceRef: null, issuedBy: null, remark: null })
  })
}

/**
 * 新客券：微信登录「新建 User」分支之后 fire-and-forget 调用。
 * 整体吞错——登录不能因为发券失败而挂。
 */
export async function issueNewcomerCoupon(userId: number): Promise<void> {
  try {
    const settings = await getMemberSettings()
    const templateId = settings.newcomer.templateId
    if (templateId == null) return

    const template = await prisma.couponTemplate.findUnique({ where: { id: templateId } })
    if (!template || template.status === 'OFF' || template.source !== 'NEWCOMER') return

    const existing = await prisma.userCoupon.findFirst({ where: { userId, templateId, source: 'NEWCOMER' } })
    if (existing) return

    await prisma.$transaction(async (tx) => {
      // 事务内二次确认，缩小（不能完全消除，UserCoupon 无 (userId,templateId,source) 唯一索引）
      // 同一新用户极短时间内重复登录导致的重复发放窗口
      const dup = await tx.userCoupon.findFirst({ where: { userId, templateId, source: 'NEWCOMER' } })
      if (dup) return
      await issueCoupon(tx, { userId, template, source: 'NEWCOMER', sourceRef: null, issuedBy: null, remark: null })
    })
  } catch (e) {
    console.error('[member/coupons] issueNewcomerCoupon 失败（不影响登录流程）:', userId, e)
  }
}

// ADMIN 来源（店员定向发放赔偿券）的具体端点 `POST /admin/users/:id/coupons` 按 spec §8
// 归属 M3（后台三个管理页那个里程碑），M1 计划的文件清单里也没有 routes/admin/users.ts——
// 这里不预先添加未被要求的服务函数，issueCoupon() 已是通用原语，M3 直接复用即可。

// ─────────────────────────────────────────────────────────
// 过期
// ─────────────────────────────────────────────────────────

export async function expireCouponsBatch(limit = 200): Promise<number> {
  const candidates = await prisma.userCoupon.findMany({
    where: { status: 'UNUSED', expiresAt: { lt: new Date() } },
    take: limit,
    select: { id: true },
  })
  if (candidates.length === 0) return 0
  const moved = await prisma.userCoupon.updateMany({
    where: { id: { in: candidates.map((c) => c.id) }, status: 'UNUSED' },
    data: { status: 'EXPIRED' },
  })
  return moved.count
}

// ─────────────────────────────────────────────────────────
// 只读查询：一律按时间判定「可用」，不依赖定时任务是否已跑
// ─────────────────────────────────────────────────────────

export type CouponListStatus = 'available' | 'used' | 'expired'

const COUPON_SELECT = {
  id: true,
  code: true,
  name: true,
  amount: true,
  threshold: true,
  channel: true,
  status: true,
  source: true,
  expiresAt: true,
  usedAt: true,
} satisfies Prisma.UserCouponSelect

/**
 * 把 issueCoupon() 返回的完整 UserCoupon 行按 GET /member/coupons 同一份白名单裁剪，
 * 供 claim/redeem 两个 POST 端点复用——不返回 issuedBy/remark/sourceRef/templateId/
 * userId 等内部字段（spec §5.7）。字段列表与 COUPON_SELECT 是同一份，改一处两边一起改。
 */
export function toCouponView<T extends Record<string, unknown>>(coupon: T): Pick<T, keyof typeof COUPON_SELECT> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(COUPON_SELECT)) out[key] = coupon[key]
  return out as Pick<T, keyof typeof COUPON_SELECT>
}

export async function listUserCoupons(userId: number, status: CouponListStatus) {
  const now = new Date()
  const where: Prisma.UserCouponWhereInput =
    status === 'available'
      ? { userId, status: 'UNUSED', expiresAt: { gt: now } }
      : status === 'used'
        ? { userId, status: 'USED' }
        : { userId, OR: [{ status: 'EXPIRED' }, { status: 'UNUSED', expiresAt: { lte: now } }] }

  return prisma.userCoupon.findMany({ where, orderBy: { id: 'desc' }, select: COUPON_SELECT })
}

export async function countAvailable(userId: number): Promise<number> {
  return prisma.userCoupon.count({ where: { userId, status: 'UNUSED', expiresAt: { gt: new Date() } } })
}
