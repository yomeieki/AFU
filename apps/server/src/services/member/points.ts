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
 * 退款扣回：与 earnRatePerYuan 无关，只看「这单已经退了多少比例」——
 * 用累计目标减已扣，而不是逐笔各自 floor 再累加：¥100 得 100 分，分三次各退 ¥33.33，
 * 逐笔 floor(100×3333/10000)=33 三次共 99，最后 1 分永远扣不回；累计公式在退满时精确扣满 pointsEarned。
 *
 * base：结算时的算分基数（Order.pointsBase）；旧单（该列上线前结算，值为 null）退化用 actualAmount。
 * cumRef：结算之后累计退了多少 = refundedAmount + base − actualAmount（refundedAmount 是全订单口径，
 *   其中「结算前已退的部分」已经体现在 base = actualAmount − 结算时 refundedAmount 里，减回来才是净增量）。
 * targetCum：按 cumRef/base 的比例，这单总共应该扣掉多少分（累计值，不是本次增量）。
 * 返回值 = targetCum − alreadyDeducted，再用 「这单还剩多少没扣回」「用户当前总余额」封顶，且不小于 0。
 */
export function calcRefundDeduct(
  pointsEarned: number,
  pointsBase: number | null,
  actualAmount: number,
  refundedAmount: number,
  alreadyDeducted: number,
  balance: number
): number {
  const base = pointsBase != null && pointsBase > 0 ? pointsBase : actualAmount
  if (base <= 0) {
    // 边界：结算时基数就是 0（罕见，实践中 pointsEarned 也会是 0 从而在调用方提前 return），
    // 没有比例可摊，只能按「已经全额退款」处理，扣掉这单剩下的全部分
    return Math.max(0, Math.min(pointsEarned - alreadyDeducted, balance))
  }
  const cumRef = Math.max(0, refundedAmount + base - actualAmount)
  const targetCum = Math.floor((pointsEarned * cumRef) / base)
  return Math.max(0, Math.min(targetCum - alreadyDeducted, pointsEarned - alreadyDeducted, balance))
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
 * 滚动续期：把该用户全部**未过期入账行**的到期日推到 `expiresAt`。
 *
 * 只有 `expiresAt` 这一个值被改，行的结构不动——所以 FIFO 扣减、`expirePoints` 扫描、
 * `GIFT_REVERT` 继承最早到期日这三套机制全都不用改，它们读的仍然是行上的 `expiresAt`。
 *
 * `expiresAt: { gt: now }` 这个条件不能省：`expirePoints` 每日才跑一次，
 * 中间会存在「按日期已过期但 remaining 还没被清零」的行。少了这个条件，
 * 一次消费就会把这些本该作废的积分**复活**。
 *
 * `expiresAt: { lt: expiresAt }`（B7）同样不能省：续期必须单调只增。没有这条上界，
 * 「补发几天前的旧单」或「调短 validDays 后再消费」都会把目标到期日算得比账户当前到期日更早，
 * 这次 updateMany 会把全账户的到期日**往前拽**——违反 docs/member-terms-copy.md X.6
 * 「规则调整不影响调整前已获得积分的有效期」，也破坏 H7/M16 依赖的「全部在世行同一天过期」前提。
 * 调用方（settlePoints）已经把目标 expiresAt 取过 max(本单目标, 账户当前在世行最大到期日)，
 * 这里的上界是双保险，不依赖调用方一定算对。
 */
async function extendLivePoints(
  tx: Prisma.TransactionClient,
  userId: number,
  expiresAt: Date,
  now: Date
): Promise<number> {
  const r = await tx.pointsLedger.updateMany({
    where: {
      userId,
      type: { in: ['EARN', 'GIFT_REVERT'] },
      remaining: { gt: 0 },
      expiresAt: { gt: now, lt: expiresAt },
    },
    data: { expiresAt },
  })
  return r.count
}

/**
 * 订单完成后发放积分。前置条件任一不满足直接返回，不抛错（调用点全是 fire-and-forget，
 * settlePoints 自身 try/catch 全包，永不向调用方抛错——调用点都是 fire-and-forget，
 * 失败由 settleMissedPoints 兜底任务补发）。pointsSettledAt 是唯一的「已处理」标记，
 * 即使 earn<=0 也要写，否则会被兜底任务永远重扫。
 *
 * H1：订单读进事务内并加行锁（第一句 `SELECT ... FOR UPDATE`），与 finalizeRefundSuccess 里
 * `UPDATE orders SET refunded_amount = ...` 那次隐式行锁互斥——settle 与部分退款并发时，
 * 谁先拿到锁谁看到的 refundedAmount 就是最新值，不会出现「两边都读到退款前的旧值，
 * settle 按满额发分、退款按 pointsEarned=0 不扣」这种永久多发。锁顺序 orders → points_ledgers →
 * users，与 finalizeRefundSuccess 一致，不会死锁。
 *
 * enabled 判断放在读到订单字段之后、任何写操作之前——关着的时候直接 return，不写
 * pointsSettledAt（B3 的既有约定）：这保证以后店主打开开关时，settleMissedPoints 的 7 天
 * 窗口仍能捡到这些单补发，而不是被一个「已处理」标记永久挡在候选集外。
 */
export async function settlePoints(orderId: number): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`
      const order = (await tx.order.findUnique({
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

      // 锁后读到的 refundedAmount 算 earn：与并发退款互斥后这里看到的一定是最新值
      const earn = calcEarn(order.actualAmount, order.refundedAmount, settings.points.earnRatePerYuan)
      const now = new Date()
      // B5：本单的算分基数，供退款扣回按比例摊（与 earnRatePerYuan 无关，见 calcRefundDeduct）
      const pointsBase = Math.max(0, order.actualAmount - order.refundedAmount)

      // B7：目标到期日取 max(本单完成时刻 + validDays, 账户当前在世行的最大到期日)，
      // 续期只增不减；见 extendLivePoints 顶部注释与 §7-2。
      const baseTarget = new Date((order.completedAt ?? now).getTime() + settings.points.validDays * 24 * 60 * 60 * 1000)
      const maxLive = await tx.pointsLedger.aggregate({
        where: { userId: order.userId, type: { in: ['EARN', 'GIFT_REVERT'] }, remaining: { gt: 0 }, expiresAt: { gt: now } },
        _max: { expiresAt: true },
      })
      const expiresAt = maxLive._max.expiresAt && maxLive._max.expiresAt > baseTarget ? maxLive._max.expiresAt : baseTarget

      if (earn <= 0) {
        // 实付不足 1 元、得分为 0 的单**照样续期**：规则写的是「最后一次消费」不是
        // 「最后一次得分」，顾客确实来买了，不该因为买得少就不算数。
        await extendLivePoints(tx, order.userId, expiresAt, now)
        await tx.order.updateMany({
          where: { id: orderId, pointsSettledAt: null },
          data: { pointsEarned: 0, pointsSettledAt: now, pointsBase },
        })
        return
      }

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
      // 本次消费把该用户全部未过期入账行的到期日一并推后。
      // 放在建行之后：新建的 EARN 行 expiresAt 本就是同一个值，被一起 update 是幂等的，
      // 不用为它单独开一条代码路径。
      await extendLivePoints(tx, order.userId, expiresAt, now)
      await tx.order.updateMany({
        where: { id: orderId, pointsSettledAt: null },
        data: { pointsEarned: earn, pointsSettledAt: now, pointsBase },
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
        // M13：CAS 的 where 补 expiresAt < now——候选列表是事务外的快照，这行有极小概率
        // 在候选选出之后、这次事务提交之前被 extendLivePoints 续期成「在世」（亚秒级窗口）。
        // 只比 remaining 不复核 expiresAt 的话，会把一条已经被续期救回来的行错误清零。
        const moved = await tx.pointsLedger.updateMany({
          where: { id, remaining: row.remaining, expiresAt: { lt: new Date() } },
          data: { remaining: 0 },
        })
        if (moved.count === 0) return false // 并发被改动（含被续期救回），下一轮扫描再处理

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
 *
 * 两处查询都加 expiresAt > now（M5）：已到期但未被 expirePointsBatch 清扫的行不算「可扣」，
 * 否则会优先扣掉这些反正马上要被清零的死行，让真正在世的积分逃过退款扣回。
 */
async function deductFromEarnRows(tx: Prisma.TransactionClient, userId: number, orderId: number, target: number): Promise<number> {
  let need = target
  let deducted = 0
  const now = new Date()

  const own = await tx.pointsLedger.findFirst({
    where: { userId, type: 'EARN', refType: 'ORDER', refId: String(orderId), expiresAt: { gt: now } },
    select: { id: true, remaining: true },
  })
  if (own && own.remaining > 0 && need > 0) {
    const took = await tryDeduct(tx, own.id, own.remaining, need)
    need -= took
    deducted += took
  }

  if (need > 0) {
    const rows = await tx.pointsLedger.findMany({
      where: { userId, type: 'EARN', remaining: { gt: 0 }, expiresAt: { gt: now } },
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
  /** 结算时的算分基数，见 calcRefundDeduct 的注释；null=旧单退化用 actualAmount */
  pointsBase: number | null
  actualAmount: number
  /** 本次退款落库（LEAST 封顶）之后的最新累计退款额 */
  refundedAmount: number
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

  const refundIds = (await tx.refund.findMany({ where: { orderId: order.id }, select: { id: true } })).map((r) => String(r.id))
  const agg = refundIds.length
    ? await tx.pointsLedger.aggregate({
        where: { type: 'REFUND_DEDUCT', refType: 'REFUND', refId: { in: refundIds } },
        _sum: { delta: true },
      })
    : { _sum: { delta: null } }
  const alreadyDeducted = Math.abs(agg._sum.delta ?? 0)

  const user = await tx.user.findUniqueOrThrow({ where: { id: order.userId }, select: { pointsBalance: true } })
  const target = calcRefundDeduct(order.pointsEarned, order.pointsBase, order.actualAmount, order.refundedAmount, alreadyDeducted, user.pointsBalance)
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
  /** 账户级到期日 = 全部在世行的最大 expiresAt（滚动续期下应等于每一行的 expiresAt）；
   *  没有任何在世行时为 null。供 M4 常驻文案「若 1 年内无消费，您的 N 分将于 X 日全部过期」使用（M16）。 */
  pointsExpireAt: string | null
}

/**
 * H7：balance 不能直接读 User.pointsBalance 冗余列——那是「未扣到期过滤」的账面值，
 * expirePoints 每日才跑一次，到期后最长约 24 小时里冗余列仍是满额，而 consumePoints
 * 按 expiresAt>now 过滤会拒绝兑换，两处口径对不上。这里改成实算 Σ(remaining>0 且未过期)，
 * 与 consumePoints 的过滤条件保持一致。
 * 30 天内到期的合计与最早日期；没有则 expiringSoon=null。
 */
export async function getPointsSummary(userId: number): Promise<PointsSummary> {
  const now = new Date()
  const soonCutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  // 按 expiresAt 升序取全部在世行：一次查询同时算出 balance（H7）、expiringSoon、
  // pointsExpireAt=max(expiresAt)（M16，滚动续期下就是最后一行）。
  const rows = await prisma.pointsLedger.findMany({
    where: { userId, type: { in: ['EARN', 'GIFT_REVERT'] }, remaining: { gt: 0 }, expiresAt: { gt: now } },
    orderBy: { expiresAt: 'asc' },
    select: { remaining: true, expiresAt: true },
  })
  const balance = rows.reduce((sum, r) => sum + r.remaining, 0)
  const soonRows = rows.filter((r) => r.expiresAt !== null && r.expiresAt <= soonCutoff)
  const soonPoints = soonRows.reduce((sum, r) => sum + r.remaining, 0)
  const soonDate = soonRows[0]?.expiresAt ?? null
  const maxExpiresAt = rows.length > 0 ? rows[rows.length - 1].expiresAt : null
  return {
    balance,
    expiringSoon: soonPoints > 0 && soonDate ? { points: soonPoints, date: soonDate.toISOString() } : null,
    pointsExpireAt: maxExpiresAt ? maxExpiresAt.toISOString() : null,
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
