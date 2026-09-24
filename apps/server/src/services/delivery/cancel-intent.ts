/**
 * 取消意图（P15-P20，2026-09-24）。
 *
 * 背景：店员多数没有快递100 企业账号，配送单缺 taskId/orderId 时既没法去后台核实，
 * 本地也没法外呼取消（precancel/cancel 都要 taskId+orderId，见 kd100.ts 生产实测 30001）。
 * 旧实现（P5 缺陷）在这种情况下直接本地伪造取消（不外呼，直接 CANCELLED）——若运力方那头
 * 其实真有一张活单，就会造出「本地已取消、运力方仍在途」的幽灵活单（P7/P19 要收拾的烂摊子）。
 *
 * 新流程（店主 D2 决定，原话「一律自动取消，扣费认了」）：
 *  1. 店员点取消 → 只记意图（recordCancelIntent），不外呼、不改状态、不释放 activeOrderId；
 *  2. 单号一到（回调认领 / 落库补录）→ 自动执行真取消（executeCancelIntent），取消费自动
 *     接受并记账，不再问店员一次；
 *  3. 5 分钟仍无回调无单号 → 自动结束为 FAILED/VOIDED（processCancelIntents，tasks.ts），
 *     释放 activeOrderId 让店员能立即重呼/自送；
 *  4. 结束之后若仍收到在途回调（幽灵活单）→ killGhostDelivery 自动向运力方撤销，只有撤销
 *     失败才告警，成功只留痕记账。
 *
 * ⚠️ 与 orchestrator.ts 存在双向 import（本文件用它的 finalizeCancel/rollbackOrderAfterCancel，
 * 它反过来在 callRider 的竞态回填与 cancelDelivery 里用本文件的 recordCancelIntent/
 * executeCancelIntent/killGhostDelivery）。两边都只在函数体内引用对方的导出（从不在模块顶层
 * 求值时调用），tsc 编译到 commonjs 时具名 import 落地成「按模块命名空间对象取属性」而不是
 * 解构成局部常量，所以哪个文件先被 require 都不影响运行期结果——晚绑定，等两边都加载完、
 * 函数真被调用时，属性早已就位。
 */
import prisma from '../../utils/prisma'
import { getDeliveryProvider } from './provider'
import { ProviderError } from './types'
import { TERMINAL } from './state'
import { recordDeliveryEvent, adminEventKey, trunc } from './events'
import { notifySystemAlert } from '../notify'
import { notifyLocalDeliveryAlert } from '../order-notify'
import { finalizeCancel, patchRacedCancelFee } from './orchestrator'

export const CANCEL_INTENT_MAX_ATTEMPTS = 5
export const CANCEL_INTENT_VOID_MIN = 5

/**
 * P22（复核 R7）：意图单收尾（自动取消成功 / 自动结束）时，如果顾客早就在等取消申请
 * 被处理（`order.cancelRequestedAt` 非空），店员的「处理顾客取消申请」弹窗在收尾之前会
 * 卡在意图等待态、退款也会被 `refund.ts` 的 42221（有在途配送单）拦下——这条通知告诉店员
 * 「现在可以回去点「去处理」退款了」。不自动退款、不放宽 42221，只是把「该去看一眼了」
 * 这件事从「店员得自己想起来刷新」变成主动推一下。
 */
export async function notifyIntentDoneIfRefundPending(orderId: number): Promise<void> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNo: true, cancelRequestedAt: true } })
  if (!o || !o.cancelRequestedAt) return
  notifyLocalDeliveryAlert('配送已结束，可处理顾客的取消申请', [
    `订单 ${o.orderNo}`,
    '配送单已取消/结束，退款不再被在途配送单拦截',
    '请到工作台点「去处理」退款',
  ], { key: `dlv-intent-done-refund:${orderId}` })
}

type DeliveryLike = {
  id: number; orderId: number; orderNo: string; deliveryNo: string
  status: string; cancelIntentAt: Date | null
}

/**
 * P15：店员对缺 taskId/orderId 的非终态配送单点「取消」——只记意图，不外呼、不改状态、
 * 不释放 activeOrderId。幂等：`cancelIntentAt` 已非空（店员重复点击/多标签页）直接返回同样
 * 的 `pending:true`，不重复留痕、不重复外呼。
 */
export async function recordCancelIntent(d: DeliveryLike, input: { operator: string; reason?: string }): Promise<{ cancelFeeFen: null; pending: true }> {
  if (d.cancelIntentAt) return { cancelFeeFen: null, pending: true }
  const moved = await prisma.delivery.updateMany({
    where: { id: d.id, status: { notIn: [...TERMINAL] }, cancelIntentAt: null },
    data: { cancelIntentAt: new Date(), cancelIntentBy: trunc(input.operator, 64), cancelIntentReason: trunc(input.reason, 255) ?? '商家取消' },
  })
  if (moved.count === 0) return { cancelFeeFen: null, pending: true }   // 并发点击/回调抢先，同样幂等
  await recordDeliveryEvent(prisma, {
    deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', operator: input.operator,
    statusDesc: '店员要求取消（缺快递100 单号），等运力方确认后自动取消；5 分钟无回应自动结束',
  })
  // 预约单同现有 ADMIN 取消清 readyAt（orchestrator.finalizeCancel 对「真取消」做的同一件事，
  // 这里独立复刻一次——记意图阶段配送单还没有终态化，走不到 finalizeCancel）
  await prisma.order.updateMany({
    where: { id: d.orderId, deliveryType: 'LOCAL', scheduledAt: { not: null }, status: 'PREPARING', readyAt: { not: null } },
    data: { readyAt: null },
  })
  return { cancelFeeFen: null, pending: true }
}

/**
 * P16：意图非空、非终态、taskId 与 orderId 都非空时，自动执行真取消。不先 precancel（店主
 * 已决定「取消费一律认了」，省一次外呼）；直接 cancelOrder，取消费从响应记账。
 *
 * 原子抢占 + 在途租约（复核 R2）：`cancelIntentAttempts` 读到的值作为 where 条件只能挡住
 * 「同时读到同一个 attempts 值」的并发触发；挡不住「第一次外呼还没返回、第二个触发点这时候
 * 进来，读到的已经是抢占后的新 attempts 值」——那种情况下第二个触发点会认为"没人抢"而再抢一次，
 * 造成重复外呼（复核实测：回调 0 认领单号触发一次，紧接着回调 100/兜底调度触发第二次，
 * 第一次外呼还没返回，两次都抢占成功）。加 `cancelIntentLockedAt` 租约：抢占条件在原有基础上
 * 追加"未加锁或加锁已超过 60 秒"（cancelOrder 超时上限 8 秒，60 秒是进程崩溃的兜底），
 * `finally` 无论成功失败都释放锁。
 */
export async function executeCancelIntent(deliveryId: number): Promise<void> {
  const d = await prisma.delivery.findUnique({ where: { id: deliveryId } })
  if (!d) return
  if (!d.cancelIntentAt) return
  if (TERMINAL.includes(d.status as typeof TERMINAL[number])) return
  if (!d.providerTaskId || !d.providerOrderId) return
  const seized = await prisma.delivery.updateMany({
    where: {
      id: d.id, cancelIntentAt: { not: null }, status: { notIn: [...TERMINAL] }, cancelIntentAttempts: d.cancelIntentAttempts,
      OR: [{ cancelIntentLockedAt: null }, { cancelIntentLockedAt: { lt: new Date(Date.now() - 60_000) } }],
    },
    data: { cancelIntentAttempts: { increment: 1 }, cancelIntentLockedAt: new Date() },
  })
  if (seized.count === 0) return   // 别人已经抢到这一次（同一轮的另一个触发点，或并发的兜底任务），或租约未到期
  try {
    const { cancelFeeFen } = await getDeliveryProvider().cancelOrder({
      taskId: d.providerTaskId, orderId: d.providerOrderId, reason: d.cancelIntentReason ?? '商家取消',
    })
    const cancelled = await prisma.$transaction(async (tx) => {
      // 重读：外呼这几百毫秒里配送单可能已经终态化（回调抢先到达把它 CANCELLED/DELIVERED 了）——
      // finalizeCancel 内部的 updateMany 本身也有 status notIn TERMINAL 护栏，这里提前判断只是
      // 避免对已终态的行调用 rollbackOrderAfterCancel/清 readyAt 这类无意义的写。
      const fresh = await tx.delivery.findUnique({ where: { id: d.id } })
      if (!fresh) return false
      if (TERMINAL.includes(fresh.status as typeof TERMINAL[number])) {
        // R1：我方这次 cancel 外呼期间，运力方为同一次取消推来的 720 回调先到，行已经被
        // callback.ts 终态化成 CANCELLED（cancelFee 默认 0）——把响应带回来的取消费补记上，
        // 不能让它平白丢掉。其它终态（理论上不该发生：DELIVERED/FAILED）什么都不做，
        // 钱的去向留给 R11（建议，未处理）里提到的收尾失败场景一并核对。
        if (fresh.status === 'CANCELLED') await patchRacedCancelFee(tx, fresh, cancelFeeFen, d.cancelIntentBy ?? 'system', 'ADMIN')
        return false
      }
      const r = await finalizeCancel(
        tx, fresh, cancelFeeFen, d.cancelIntentReason ?? '商家取消', d.cancelIntentBy ?? 'system', 'ADMIN',
        (feeYuan) => `已自动向快递100 取消（取消费 ¥${feeYuan}，已记账）`,
      )
      return r.moved === 1
    })
    // P22（R7）：真的把配送单终态化成 CANCELLED 了才通知——顾客若早就申请了取消，
    // 现在退款不会再被 42221 拦下，店员该回去点「去处理」了。
    if (cancelled) void notifyIntentDoneIfRefundPending(d.orderId)
  } catch (e) {
    const msg = e instanceof ProviderError ? `${e.kind}:${e.code} ${e.message}` : (e as Error).message
    await prisma.delivery.updateMany({ where: { id: d.id }, data: { cancelIntentLastError: trunc(msg, 255) } })
    const after = await prisma.delivery.findUnique({
      where: { id: d.id },
      select: { cancelIntentAttempts: true, cancelIntentAlertedAt: true, orderNo: true, deliveryNo: true, providerTaskId: true, providerOrderId: true },
    })
    if (after && after.cancelIntentAttempts >= CANCEL_INTENT_MAX_ATTEMPTS && !after.cancelIntentAlertedAt) {
      // 「只发一次」用 cancelIntentAlertedAt 本身做条件写去重，与全仓其它提醒任务同一范式
      const marked = await prisma.delivery.updateMany({ where: { id: d.id, cancelIntentAlertedAt: null }, data: { cancelIntentAlertedAt: new Date() } })
      if (marked.count > 0) {
        notifySystemAlert('配送单自动取消失败，需人工处理', [
          `配送单 ${after.deliveryNo}（订单 ${after.orderNo}）`,
          `店员要求取消，系统已 ${CANCEL_INTENT_MAX_ATTEMPTS} 次向快递100 取消失败，最后错误：${msg}`,
          `taskId=${after.providerTaskId ?? ''} orderId=${after.providerOrderId ?? ''}；骑手可能仍在途，请管理员登录快递100 企业后台取消该单——后台取消后系统会收到 720 回调自动收尾，不必再在工作台操作`,
        ], { key: `dlv-cancel-intent-failed:${d.id}` })
      }
    }
  } finally {
    // 租约无论成败都要释放——成功时行多半已终态（释放与否不再影响谁），失败时必须放行，
    // 不然下一次重试（兜底调度或回调）永远读到"未过期的锁"，5 次重试机制直接失效。
    await prisma.delivery.updateMany({ where: { id: d.id }, data: { cancelIntentLockedAt: null } })
  }
}

/**
 * P17：`processCancelIntents` 每分钟扫描调用，条件写细节见 tasks.ts。这里只是
 * `executeCancelIntent` 的批量入口，供调度任务复用同一条真取消路径，避免另写一份。
 */

/**
 * 验收标准 13 要求的纯函数：已结束（FAILED/CANCELLED 且无 taskId）的配送单还该不该在收到
 * 这条回调时自动向运力方撤销。selftest-delivery-core.ts 直接断言这张表，不经数据库。
 *
 *  - FAILED + rank<100 → true（多半是 P17 自动结束后单号才姗姗来迟，或人工作废后被重呼）
 *  - CANCELLED 且无 taskId + rank<100 → true（SELF 之外理论上不该发生，防御性兜底）
 *  - CANCELLED 有 taskId → false（我方主动 cancel 过，尾随的迟到回调预期之内，静默留痕即可）
 *  - 任何 status + rank===100（520 已送达）→ false（撤不了，只能告「已送达，请核对费用」）
 *  - side（515/510/720，非 rank 类型）→ false（旁路态不构成「幽灵活单」；照旧留痕即可）
 */
/**
 * 复核 R3 + 验收 24：P17(b) 自动结束分支该不该收这一行——方案原文是「任一 id 为空」，
 * 旧代码只判断了 providerTaskId，导致「有 taskId 无 orderId」的行永久卡住。tasks.ts 的
 * processCancelIntents 直接调用这个函数决定 where 条件里的分支，selftest 断言的就是它本身
 * （不是复刻一份逻辑）——删掉 `!providerOrderId` 那一半，这条断言会先变红。
 */
export function shouldAutoVoidCancelIntent(providerTaskId: string | null, providerOrderId: string | null): boolean {
  return !providerTaskId || !providerOrderId
}

export function shouldKillGhost(
  status: string,
  providerTaskId: string | null,
  mapped: { type: 'rank'; rank: number } | { type: 'side' } | undefined,
): boolean {
  if (!mapped || mapped.type !== 'rank') return false
  if (mapped.rank >= 100) return false
  if (status === 'FAILED') return true
  if (status === 'CANCELLED' && !providerTaskId) return true
  return false
}

/**
 * R15-2（复核第 2 轮）：killGhostDelivery 缺 orderId 时该不该告警——只在骑手确认在动
 * （rank>=20：100/210/230/310）时才升级为告警；`0`（rank10，仅「已呼叫待抢单」，
 * 并呼噪声，不代表真有骑手动了）和 rank>=100（终态，shouldKillGhost 早已挡在外面，
 * 不会传到这里）都不告警。
 */
export function ghostNoIdShouldAlert(rank: number): boolean {
  return rank >= 20 && rank < 100
}

/**
 * P19：已结束的配送单仍收到在途回调（幽灵活单）→ 自动向运力方撤销。原子抢占（ghostCancelAt）
 * 保证同批多条回调只有一个真的外呼；调用方（callback.ts）已在同一次回调事务里把 taskId/
 * orderId 按列认领到这张行上（P3），这里直接读行上的值即可，不需要调用方再传一遍。
 *
 * 复核 R4：顺序改成「先读行、两 id 都齐全才抢占」——旧版先无条件抢占 `ghostCancelAt`，
 * 缺 orderId 的那一条回调（常见：720 之外的旁路状态、或运力方这次回调本就没带 orderId）
 * 会把占位烧掉，之后带着完整 id 的回调再来时 `seized.count===0`（占位已被烧）直接放弃，
 * 全程不外呼也不告警，幽灵活单永远撤不掉。现在缺 id 时不抢占，只留一条 `GHOSTWAIT:` 事件
 * （按 deliveryId+status 去重，同一状态下重复的缺 id 回调不会连续刷事件），等下一条带全 id
 * 的回调再来才真正抢占。
 */
export async function killGhostDelivery(
  deliveryId: number,
  ctx: { providerStatus: string; rank: number; statusDesc: string | null; courierName: string | null; courierMobile: string | null },
): Promise<void> {
  const d = await prisma.delivery.findUnique({ where: { id: deliveryId } })
  if (!d) return
  if (!d.providerTaskId || !d.providerOrderId) {
    // R15-2：事件去重键按「是否达到告警门槛」分桶，而不是笼统按 deliveryId+status——
    // 这样同一状态下反复出现的低 rank 噪声（如多条并呼 `0`）只留一条事件，但从低 rank
    // 升到高 rank（骑手确认在动）时会新留一条，事件本身也能看出「何时升级」。
    const alertEligible = ghostNoIdShouldAlert(ctx.rank)
    try {
      await recordDeliveryEvent(prisma, {
        deliveryId, dedupeKey: `GHOSTWAIT:${deliveryId}:${d.status}:${alertEligible ? 'ALERT' : 'WAIT'}`.slice(0, 64), source: 'CALLBACK',
        statusDesc: `已结束配送单收到在途回调（${ctx.providerStatus}${ctx.statusDesc ? ` ${ctx.statusDesc}` : ''}），但 taskId/orderId 尚不齐全（taskId=${d.providerTaskId ?? '缺'} orderId=${d.providerOrderId ?? '缺'}），暂不撤销，等下一条回调带齐后自动处理`,
      })
    } catch { /* 留痕失败不升级 */ }
    if (alertEligible) {
      notifySystemAlert('已结束的配送单有骑手在途，但缺 orderId 无法自动撤销', [
        `配送单 ${d.deliveryNo}（订单 ${d.orderNo}，本地 ${d.status}/${d.errorCode ?? ''}）`,
        `回调状态 ${ctx.providerStatus}（${ctx.statusDesc ?? ''}），骑手 ${ctx.courierName ?? ''}${ctx.courierMobile ? ` ${ctx.courierMobile}` : ''}`,
        `taskId=${d.providerTaskId ?? ''} orderId=缺：快递100 取消接口必填 orderId，系统无法自动撤销`,
        '该订单可能已重呼/自送，请管理员立即在快递100 后台按 taskId 取消，避免两个骑手两笔费用',
      ], { key: `kd-cb-ghost-noid:${d.id}` })
    }
    return
  }
  const seized = await prisma.delivery.updateMany({ where: { id: deliveryId, ghostCancelAt: null }, data: { ghostCancelAt: new Date() } })
  if (seized.count === 0) return   // 同批多条回调，另一条已经抢到
  try {
    const { cancelFeeFen } = await getDeliveryProvider().cancelOrder({
      taskId: d.providerTaskId, orderId: d.providerOrderId, reason: '已结束配送单收到在途回调，自动撤销',
    })
    const fee = cancelFeeFen ?? 0
    await prisma.$transaction(async (tx) => {
      await tx.delivery.updateMany({ where: { id: d.id }, data: { cancelFee: { increment: fee } } })
      await recordDeliveryEvent(tx, {
        deliveryId: d.id, dedupeKey: adminEventKey(), source: 'CALLBACK', operator: 'system',
        statusDesc: `已结束配送单仍有在途回调，已自动向快递100 撤销（取消费 ¥${(fee / 100).toFixed(2)}，已记账）`,
      })
    })
  } catch (e) {
    const msg = e instanceof ProviderError ? `${e.kind}:${e.code} ${e.message}` : (e as Error).message
    notifySystemAlert('已结束的配送单仍有在途回调，自动撤销失败', [
      `配送单 ${d.deliveryNo}（订单 ${d.orderNo}，本地 ${d.status}）`,
      `系统凭 taskId=${d.providerTaskId} orderId=${d.providerOrderId} 自动撤销失败：${msg}`,
      '骑手可能到店/二次配送，请管理员在快递100 后台取消',
    ], { key: `kd-cb-ghost-active:${d.id}` })
  }
}
