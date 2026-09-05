/**
 * 积分账本：发放 / FIFO 扣减 / 过期 / 退款扣回 的唯一实现。
 * 设计依据：docs/superpowers/specs/2026-09-04-member-points-coupon-design.md §5.4。
 *
 * 全局约定（不要在别处重新发明）：
 * - 可用积分行（下称「入账行」）= type IN ('EARN','GIFT_REVERT') && remaining > 0 && expiresAt > now。
 * - 扣减一律 updateMany({ where: { id, remaining: { gte: take } } }) 判 count，count=0 视为被并发抢走。
 * - PointsLedger.@@unique([type, refType, refId]) 是幂等唯一防线：任何写流水的地方都要能容忍 P2002。
 * - User.pointsBalance 是冗余缓存，权威永远是 Σ入账行.remaining（见 scripts/check-points-consistency.mjs）。
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { AppError } from '../../middlewares/error'
import { notifySystemAlert } from '../notify'
import { getMemberSettings } from './settings'

export type LedgerType = 'EARN' | 'REDEEM' | 'GIFT' | 'GIFT_REVERT' | 'REFUND_DEDUCT' | 'EXPIRE' | 'ADMIN'
export type LedgerRefType = 'ORDER' | 'COUPON' | 'REFUND' | 'LEDGER'

const LEDGER_TYPE_LABEL: Record<string, string> = {
  EARN: '消费得分',
  REDEEM: '积分兑换',
  GIFT: '随单赠品',
  GIFT_REVERT: '取消退回',
  REFUND_DEDUCT: '退款扣回',
  EXPIRE: '积分过期',
  ADMIN: '手动调整',
}

function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

// ─────────────────────────────────────────────────────────
// 纯函数（selftest-member.ts 覆盖）
// ─────────────────────────────────────────────────────────

/** 消费得分：按实付（扣除已退款部分）取整算分，负数一律按 0 处理 */
export function calcEarn(actualAmount: number, refundedAmount: number, ratePerYuan: number): number {
  return Math.floor(Math.max(0, actualAmount - refundedAmount) / 100) * ratePerYuan
}

/**
 * 退款扣回上限：三者取最小且不小于 0——
 * 本次退款按比例应扣的量、这单还剩多少没扣回、用户当前总余额。
 * 任何一者为 0 都不该继续往下扣（不能出现负余额，也不能扣超过这单给过的分）。
 */
export function calcRefundDeduct(
  refundAmount: number,
  ratePerYuan: number,
  earned: number,
  alreadyDeducted: number,
  balance: number
): number {
  return Math.max(0, Math.min(Math.floor(refundAmount / 100) * ratePerYuan, earned - alreadyDeducted, balance))
}

// ─────────────────────────────────────────────────────────
// FIFO 扣减
// ─────────────────────────────────────────────────────────

export interface ConsumePointsMeta {
  type: LedgerType
  refType: LedgerRefType
  refId: string
  remark?: string
}

export interface ConsumePointsResult {
  /** 本次实际扣到的入账行里最早的到期日；没扣到任何行（amount<=0）则为 null。
   *  调用方（M2 的赠品扣分）把它写进 GIFT 出账行的 expiresAt，供未支付取消释放时
   *  GIFT_REVERT 继承——退回来的积分不该比原来更耐用（spec §5.5）。 */
  minExpiresAt: Date | null
}

/**
 * FIFO 扣减：按 expiresAt ASC, id ASC 取入账行逐行条件扣减，被并发抢走则重取一次，
 * 两轮仍不足抛 AppError(42250)。成功后写一条负 delta 流水 + User.pointsBalance decrement。
 * 必须在调用方的事务 tx 内执行，不自开事务。
 */
export async function consumePoints(
  tx: Prisma.TransactionClient,
  userId: number,
  amount: number,
  meta: ConsumePointsMeta
): Promise<ConsumePointsResult> {
  if (!Number.isInteger(amount) || amount <= 0) return { minExpiresAt: null }

  let need = amount
  let minExpiresAt: Date | null = null
  const now = new Date()

  for (let round = 0; round < 2 && need > 0; round++) {
    const rows = await tx.pointsLedger.findMany({
      where: { userId, type: { in: ['EARN', 'GIFT_REVERT'] }, remaining: { gt: 0 }, expiresAt: { gt: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: { id: true, remaining: true, expiresAt: true },
    })
    for (const row of rows) {
      if (need <= 0) break
      const take = Math.min(row.remaining, need)
      if (take <= 0) continue
      const moved = await tx.pointsLedger.updateMany({
        where: { id: row.id, remaining: { gte: take } },
        data: { remaining: { decrement: take } },
      })
      if (moved.count === 0) continue // 被并发抢走，这轮跳过，留给下一轮重取
      need -= take
      if (row.expiresAt && (!minExpiresAt || row.expiresAt < minExpiresAt)) minExpiresAt = row.expiresAt
    }
  }

  if (need > 0) throw new AppError(42250, '积分不足')

  const updated = await tx.user.update({ where: { id: userId }, data: { pointsBalance: { decrement: amount } } })
  await tx.pointsLedger.create({
    data: {
      userId,
      type: meta.type,
      delta: -amount,
      balanceAfter: updated.pointsBalance,
      remaining: 0,
      refType: meta.refType,
      refId: meta.refId,
      remark: meta.remark ?? null,
    },
  })
  return { minExpiresAt }
}

// ─────────────────────────────────────────────────────────
// 发放
// ─────────────────────────────────────────────────────────

interface SettleOrder {
  id: number
  orderNo: string
  userId: number
  status: string
  isTest: boolean
  actualAmount: number
  refundedAmount: number
  pointsSettledAt: Date | null
  completedAt: Date | null
}

/**
 * 订单完成后发放积分。前置条件任一不满足直接返回，不抛错（调用点全是 fire-and-forget）。
 * pointsSettledAt 是唯一的「已处理」标记，即使 earn<=0 也要写，否则会被兜底任务永远重扫。
 */
export async function settlePoints(orderId: number): Promise<void> {
  try {
    const order = (await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, orderNo: true, userId: true, status: true, isTest: true,
        actualAmount: true, refundedAmount: true, pointsSettledAt: true, completedAt: true,
      },
    })) as SettleOrder | null
    if (!order) return
    if (order.status !== 'COMPLETED') return
    if (order.isTest) return
    if (order.pointsSettledAt !== null) return

    const settings = await getMemberSettings()
    if (!settings.points.enabled) return

    const earn = calcEarn(order.actualAmount, order.refundedAmount, settings.points.earnRatePerYuan)
    const now = new Date()

    if (earn <= 0) {
      await prisma.order.updateMany({
        where: { id: orderId, pointsSettledAt: null },
        data: { pointsEarned: 0, pointsSettledAt: now },
      })
      return
    }

    const expiresAt = new Date((order.completedAt ?? now).getTime() + settings.points.validDays * 24 * 60 * 60 * 1000)

    await prisma.$transaction(async (tx) => {
      let created = true
      try {
        await tx.pointsLedger.create({
          data: {
            userId: order.userId, type: 'EARN', delta: earn, remaining: earn, balanceAfter: 0,
            refType: 'ORDER', refId: String(order.id), expiresAt,
            remark: `订单 ${order.orderNo} 完成结算得分`,
          },
        })
      } catch (e) {
        if (!isUniqueConflict(e)) throw e
        created = false // 已经发过（并发命中 @@unique），吞掉后仍要补写订单标记
      }
      if (created) {
        const updatedUser = await tx.user.update({ where: { id: order.userId }, data: { pointsBalance: { increment: earn } } })
        await tx.pointsLedger.updateMany({
          where: { userId: order.userId, type: 'EARN', refType: 'ORDER', refId: String(order.id) },
          data: { balanceAfter: updatedUser.pointsBalance },
        })
      }
      await tx.order.updateMany({
        where: { id: orderId, pointsSettledAt: null },
        data: { pointsEarned: earn, pointsSettledAt: now },
      })
    })
  } catch (e) {
    // 永不向调用方抛错：全部调用点都是 fire-and-forget，失败由 settleMissedPoints 兜底任务补发
    console.error('[member/points] settlePoints 失败，等待兜底任务重扫:', orderId, e)
    notifySystemAlert('积分结算失败', [`订单 #${orderId}`, (e as Error).message], { key: `settle-points:${orderId}` })
  }
}

// ─────────────────────────────────────────────────────────
// 过期
// ─────────────────────────────────────────────────────────

/** 扫过期入账行，批量置 remaining=0 + 写 EXPIRE 流水 + 余额同步。返回处理条数。 */
export async function expirePointsBatch(limit = 200): Promise<number> {
  const candidates = await prisma.pointsLedger.findMany({
    where: { type: { in: ['EARN', 'GIFT_REVERT'] }, remaining: { gt: 0 }, expiresAt: { lt: new Date() } },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true },
  })

  let count = 0
  for (const { id } of candidates) {
    try {
      const processed = await prisma.$transaction(async (tx) => {
        // 重新在事务内读一次当前 remaining：批量候选列表是事务外的快照，
        // 拿它当扣减量会在并发消耗后把 pointsBalance 多扣——这里必须用当场读到的值。
        const row = await tx.pointsLedger.findUnique({ where: { id }, select: { remaining: true, userId: true } })
        if (!row || row.remaining <= 0) return false
        const moved = await tx.pointsLedger.updateMany({
          where: { id, remaining: row.remaining },
          data: { remaining: 0 },
        })
        if (moved.count === 0) return false // 并发被改动，下一轮扫描再处理

        const updatedUser = await tx.user.update({ where: { id: row.userId }, data: { pointsBalance: { decrement: row.remaining } } })
        try {
          await tx.pointsLedger.create({
            data: {
              userId: row.userId, type: 'EXPIRE', delta: -row.remaining, balanceAfter: updatedUser.pointsBalance,
              remaining: 0, refType: 'LEDGER', refId: String(id), remark: '积分过期',
            },
          })
        } catch (e) {
          if (!isUniqueConflict(e)) throw e // @@unique 天然防重，理论不可达，防御性兜底
        }
        return true
      })
      if (processed) count++
    } catch (e) {
      console.error('[member/points] expirePointsBatch 处理流水行失败:', id, e)
    }
  }
  return count
}

// ─────────────────────────────────────────────────────────
// 退款扣回
// ─────────────────────────────────────────────────────────

/**
 * 在该行 remaining 允许的范围内尽量扣 need，返回本次实际扣掉的量（可能小于 need，不抛错）。
 */
async function tryDeduct(tx: Prisma.TransactionClient, rowId: number, remaining: number, need: number): Promise<number> {
  const take = Math.min(remaining, need)
  if (take <= 0) return 0
  const moved = await tx.pointsLedger.updateMany({
    where: { id: rowId, remaining: { gte: take } },
    data: { remaining: { decrement: take } },
  })
  return moved.count > 0 ? take : 0
}

/**
 * 退款扣回积分只从 EARN 行扣（不动 GIFT_REVERT，那是另一单未支付取消释放回来的，与本单退款无关）：
 * 先扣本订单自己那条 EARN 行，不足再按 FIFO 扣该用户其他 EARN 行，仍不足就扣到 0 为止（用户已经
 * 花掉了，不追）。返回值是「实际」扣掉的量——可能小于目标值 target，用它而不是 target 去减
 * User.pointsBalance，是为了在任何情况下都维持「余额 == Σ 入账行 remaining」这条不变式。
 */
async function deductFromEarnRows(tx: Prisma.TransactionClient, userId: number, orderId: number, target: number): Promise<number> {
  let need = target
  let deducted = 0

  const own = await tx.pointsLedger.findFirst({
    where: { userId, type: 'EARN', refType: 'ORDER', refId: String(orderId) },
    select: { id: true, remaining: true },
  })
  if (own && own.remaining > 0 && need > 0) {
    const took = await tryDeduct(tx, own.id, own.remaining, need)
    need -= took
    deducted += took
  }

  if (need > 0) {
    const rows = await tx.pointsLedger.findMany({
      where: { userId, type: 'EARN', remaining: { gt: 0 } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: { id: true, remaining: true },
    })
    for (const row of rows) {
      if (need <= 0) break
      const took = await tryDeduct(tx, row.id, row.remaining, need)
      need -= took
      deducted += took
    }
  }
  return deducted
}

interface RefundDeductOrder {
  id: number
  userId: number
  orderNo: string
  pointsEarned: number
}
interface RefundDeductRefund {
  id: number
  amount: number
}

/**
 * 在 finalizeRefundSuccess 的事务末尾调用。deduct===0（该单没发过分 / 已扣完 / 用户已无余额）
 * 时不写任何流水——不必留痕，因为没扣任何东西。
 */
export async function deductPointsOnRefund(
  tx: Prisma.TransactionClient,
  order: RefundDeductOrder,
  refund: RefundDeductRefund
): Promise<void> {
  if (order.pointsEarned <= 0) return

  const settings = await getMemberSettings()
  const refundIds = (await tx.refund.findMany({ where: { orderId: order.id }, select: { id: true } })).map((r) => String(r.id))
  const agg = refundIds.length
    ? await tx.pointsLedger.aggregate({
        where: { type: 'REFUND_DEDUCT', refType: 'REFUND', refId: { in: refundIds } },
        _sum: { delta: true },
      })
    : { _sum: { delta: null } }
  const alreadyDeducted = Math.abs(agg._sum.delta ?? 0)

  const user = await tx.user.findUniqueOrThrow({ where: { id: order.userId }, select: { pointsBalance: true } })
  const target = calcRefundDeduct(refund.amount, settings.points.earnRatePerYuan, order.pointsEarned, alreadyDeducted, user.pointsBalance)
  if (target <= 0) return

  const actualDeducted = await deductFromEarnRows(tx, order.userId, order.id, target)
  if (actualDeducted <= 0) return

  const updatedUser = await tx.user.update({ where: { id: order.userId }, data: { pointsBalance: { decrement: actualDeducted } } })
  try {
    await tx.pointsLedger.create({
      data: {
        userId: order.userId, type: 'REFUND_DEDUCT', delta: -actualDeducted, balanceAfter: updatedUser.pointsBalance,
        remaining: 0, refType: 'REFUND', refId: String(refund.id),
        remark: `订单 ${order.orderNo} 退款 ¥${(refund.amount / 100).toFixed(2)} 扣回积分`,
      },
    })
  } catch (e) {
    if (!isUniqueConflict(e)) throw e
    // 理论不可达：finalizeRefundSuccess 对同一 refund 的状态翻转只会成功一次，走到这里前必然是
    // 首次处理。真出现说明有更深的并发问题，告警排查而非静默吞掉（此时上面的 decrement 已生效，
    // 但整个函数在 finalizeRefundSuccess 的事务里，抛出会回滚——这里选择不抛，只留痕待查，因为
    // 钱已经真退了，不该因为积分侧的意外并发让整笔退款回滚）。
    notifySystemAlert('退款积分扣回重复记账', [`订单 ${order.orderNo}`, `退款单 #${refund.id}`], {
      key: `refund-deduct-dup:${refund.id}`,
    })
  }
}

// ─────────────────────────────────────────────────────────
// 只读查询
// ─────────────────────────────────────────────────────────

export interface PointsSummary {
  balance: number
  expiringSoon: { points: number; date: string } | null
}

/** 30 天内到期的合计与最早日期；没有则 expiringSoon=null */
export async function getPointsSummary(userId: number): Promise<PointsSummary> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { pointsBalance: true } })
  const now = new Date()
  const soonCutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  const rows = await prisma.pointsLedger.findMany({
    where: { userId, type: { in: ['EARN', 'GIFT_REVERT'] }, remaining: { gt: 0 }, expiresAt: { gt: now, lte: soonCutoff } },
    orderBy: { expiresAt: 'asc' },
    select: { remaining: true, expiresAt: true },
  })
  const points = rows.reduce((sum, r) => sum + r.remaining, 0)
  const date = rows[0]?.expiresAt ?? null
  return {
    balance: user.pointsBalance,
    expiringSoon: points > 0 && date ? { points, date: date.toISOString() } : null,
  }
}

export interface LedgerListItem {
  id: number
  type: string
  typeLabel: string
  delta: number
  refType: string
  refId: string
  remark: string | null
  createdAt: Date
}

export async function listLedger(userId: number, page = 1, pageSize = 20): Promise<{ list: LedgerListItem[]; total: number; page: number; pageSize: number }> {
  const p = Math.max(1, page)
  const size = Math.min(100, Math.max(1, pageSize))
  const [rows, total] = await Promise.all([
    prisma.pointsLedger.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      skip: (p - 1) * size,
      take: size,
      select: { id: true, type: true, delta: true, refType: true, refId: true, remark: true, createdAt: true },
    }),
    prisma.pointsLedger.count({ where: { userId } }),
  ])
  return {
    list: rows.map((r) => ({ ...r, typeLabel: LEDGER_TYPE_LABEL[r.type] ?? r.type })),
    total,
    page: p,
    pageSize: size,
  }
}
