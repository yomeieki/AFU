/**
 * 同城配送兜底任务。全部「先 updateMany 打标、count=1 才推送」——标记列是唯一真相，
 * 并发双 tick 或告警发送失败都不会造成重复打扰（宁可漏一条提醒，不可轰炸店员）。
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { config } from '../../config'
import { getLocalSettings, isOpenNow } from '../local-settings'
import { getExpressSettings } from '../express-settings'
import { rejectCancelRequest } from '../cancel-request'
import { isCircuitTripped } from './circuit'
import { callRider, cancelDelivery, precancelDelivery, getActiveDelivery, HELD_OF, NEXT_RUNG, DeliveryCallStrategy } from './orchestrator'
import { refreshOrderQuote, QUOTE_FRESH_MS } from './quote'
import { recordDeliveryEvent, adminEventKey } from './events'
import { notifySystemAlert } from '../notify'
import { notifyLocalDeliveryAlert, notifyExpressAlert } from '../order-notify'
import { DELIVERY_STATUS_LABEL, TERMINAL, providerLabel } from './state'

const BATCH = 100
const ago = (min: number) => new Date(Date.now() - min * 60 * 1000)

/** Delivery.calledProviders（Json 列）→ 「达达」这样的可读文案，给告警用。读不出就留空 */
const calledLabel = (v: Prisma.JsonValue | null): string =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(providerLabel).join('、') : ''

/** Delivery CALLING 超时无人接单（每单只推一次） */
export async function remindCallTimeout(min?: number): Promise<number> {
  const s = await getLocalSettings()
  const threshold = min ?? s.callTimeoutMin
  const rows = await prisma.delivery.findMany({
    where: { status: 'CALLING', calledAt: { lt: ago(threshold) }, callTimeoutRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true, calledAt: true },
  })
  let n = 0
  for (const d of rows) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, callTimeoutRemindedAt: null }, data: { callTimeoutRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('待抢单超时', [`订单 ${d.orderNo}`, `已等待超过 ${threshold} 分钟无人接单`, '可加小费、继续等待或改自己送'])
  }
  return n
}

/** 骑手接单/赶来/已到店后长时间无进一步进展（每单只推一次） */
export async function remindAcceptedStuck(min?: number): Promise<number> {
  const s = await getLocalSettings()
  const threshold = min ?? s.acceptedStuckMin
  const rows = await prisma.delivery.findMany({
    where: { status: { in: ['ACCEPTED', 'ARRIVING', 'ARRIVED'] }, acceptedAt: { lt: ago(threshold) }, acceptedStuckRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true, status: true },
  })
  let n = 0
  for (const d of rows) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, acceptedStuckRemindedAt: null }, data: { acceptedStuckRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('骑手接单后卡住', [`订单 ${d.orderNo}`, `已超过 ${threshold} 分钟仍在「${DELIVERY_STATUS_LABEL[d.status] ?? d.status}」`, '请联系骑手核实进度'])
  }
  return n
}

/** 骑手已取货但长时间未送达（每单只推一次） */
export async function remindDeliveringTimeout(min?: number): Promise<number> {
  const s = await getLocalSettings()
  const threshold = min ?? s.deliveringTimeoutMin
  const rows = await prisma.delivery.findMany({
    where: { status: 'DELIVERING', pickedUpAt: { lt: ago(threshold) }, deliveringRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true },
  })
  let n = 0
  for (const d of rows) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, deliveringRemindedAt: null }, data: { deliveringRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('配送超时未送达', [`订单 ${d.orderNo}`, `已取货超过 ${threshold} 分钟仍未送达`, '请联系骑手核实进度'])
  }
  return n
}

/** 下单响应超时留下的 UNKNOWN 幽灵单，长时间无回调认领（每单只推一次，要老板去快递100后台核对） */
export async function remindUnknownGhost(min = 10): Promise<number> {
  const rows = await prisma.delivery.findMany({
    where: { status: 'UNKNOWN', calledAt: { lt: ago(min) }, unknownRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true, deliveryNo: true },
  })
  let n = 0
  for (const d of rows) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, unknownRemindedAt: null }, data: { unknownRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifySystemAlert('配送单状态长时间未确认', [`订单 ${d.orderNo}（${d.deliveryNo}）`, `已超过 ${min} 分钟无回调认领`, '请到快递100 后台核对：有单等回调或人工作废，无单直接作废'], { key: `dlv-unknown:${d.id}` })
  }
  return n
}

/** 备餐超时仍未呼叫骑手，也没有在途配送单（每单只推一次） */
export async function remindLocalUncalled(min = 10): Promise<number> {
  const rows = await prisma.order.findMany({
    where: {
      deliveryType: 'LOCAL', scheduledAt: null, status: 'PREPARING', cancelRequestedAt: null,
      acceptedAt: { lt: ago(min) }, localUncalledRemindedAt: null,
      deliveries: { none: { activeOrderId: { not: null } } },
    },
    take: BATCH, select: { id: true, orderNo: true },
  })
  let n = 0
  for (const o of rows) {
    const marked = await prisma.order.updateMany({ where: { id: o.id, localUncalledRemindedAt: null }, data: { localUncalledRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('备餐超时未呼叫骑手', [`订单 ${o.orderNo}`, `已接单超过 ${min} 分钟仍未呼叫骑手`, '请尽快呼叫或自己送'])
  }
  return n
}

/** 顾客取消申请长时间无人处理（每单只推一次）。同城与邮寄共用同一阈值 min，各自走对应告警渠道 */
export async function remindCancelRequestPending(min = 5): Promise<number> {
  const rows = await prisma.order.findMany({
    where: {
      cancelRequestedAt: { lt: ago(min) },
      status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED'] },
      cancelRequestRemindedAt: null,
    },
    take: BATCH, select: { id: true, orderNo: true, deliveryType: true },
  })
  let n = 0
  for (const o of rows) {
    const marked = await prisma.order.updateMany({ where: { id: o.id, cancelRequestRemindedAt: null }, data: { cancelRequestRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    const alert = o.deliveryType === 'EXPRESS' ? notifyExpressAlert : notifyLocalDeliveryAlert
    alert('顾客取消申请待处理', [`订单 ${o.orderNo}`, `取消申请已挂起超过 ${min} 分钟`, '请尽快确认是否取消'])
  }
  return n
}

/**
 * 取消申请超时未处理 → **自动驳回**（PO 2026-09-07 定的「甲」口径）。
 *
 * 计时从**接单**起算，阈值直接复用 `acceptGraceMin`——这不是偷懒，是「甲」的定义：
 * 顾客能申请的窗口与店员能处理的窗口是**同一条线**，一句话说得清：
 * 「接单 5 分钟之后这一单就不能取消了，无论谁点」。所以这里绝不能引入第二个阈值设置，
 * 否则两条线一旦被调成不一样，就会出现「顾客还能申请、但申请一落地就被自动驳回」的荒谬状态。
 *
 * 为什么必须有这个任务：顾客在第 4 分钟申请、店员在忙——这条申请会一直挂着，而它
 * **挡着「呼叫骑手」**（callRider 对 cancelRequestedAt 是硬拦截），订单就卡在备餐中走不了。
 *
 * 代价（PO 已知悉并接受）：顾客第 4:30 申请，店员只剩 30 秒。调度器 60 秒一跳，
 * 所以实际驳回落在 5:00–6:00 之间。
 *
 * ⚠️ 与 `remindCancelRequestPending` 的关系：那个任务在 acceptGraceMin=5 的当前配置下
 * 基本永远轮不到（自动驳回总是先到），但它**不是死代码**——店主若把可取消窗口调大到 30 分钟，
 * 申请就能真的挂很久，那时它才是有用的。两者阈值不同、语义不同，保留。
 *
 * EXPRESS 复用同一口径：同城读同城 acceptGraceMin、邮寄读邮寄 acceptGraceMin——阈值不传时
 * 各走各的配置；e2e 传 min 覆盖时对两个渠道统一生效（覆盖口本就是给联调用的，不细分渠道）。
 * 实际的 updateMany 抽到 services/cancel-request.ts 的 rejectCancelRequest，两渠道共用。
 */
export async function autoRejectStaleCancelRequests(min?: number): Promise<number> {
  const localS = await getLocalSettings()
  const expressS = await getExpressSettings()
  const localThreshold = min ?? localS.acceptGraceMin
  const expressThreshold = min ?? expressS.acceptGraceMin
  const rows = await prisma.order.findMany({
    where: {
      status: 'PREPARING',
      cancelRequestedAt: { not: null },
      OR: [
        { deliveryType: 'LOCAL', scheduledAt: null, acceptedAt: { lt: ago(localThreshold) } },
        { deliveryType: 'EXPRESS', acceptedAt: { lt: ago(expressThreshold) } },
      ],
    },
    take: BATCH, select: { id: true, orderNo: true, cancelRequestNote: true, deliveryType: true },
  })
  let n = 0
  for (const o of rows) {
    // requireStatus:'PREPARING' 走 main 上旧版内联实现的严格口径——单条 updateMany 精确匹配
    // status，而不是「非终态都算」（那是手动驳回的口径，见 cancel-request.ts 顶注）：这里的
    // rows 是几十毫秒前的快照，店员这瞬间把单子挪到了 SHIPPED/REFUNDING 之类，旧口径会让
    // updateMany 天然匹配不上（count=0），返回 null 静默跳过；不需要订单详情所以 returnOrder:false。
    const moved = await rejectCancelRequest(o.id, 'AUTO', { requireStatus: 'PREPARING', returnOrder: false })
    if (!moved) continue
    n++
    const threshold = o.deliveryType === 'LOCAL' ? localThreshold : expressThreshold
    // 告知而不是告警：这是预期内的规则生效，不是异常。但店员该知道「有个顾客想取消、
    // 系统按规则替你回绝了」——他可能想主动打个电话，而不是等顾客打进来。
    const alert = o.deliveryType === 'EXPRESS' ? notifyExpressAlert : notifyLocalDeliveryAlert
    alert('取消申请已自动驳回', [
      `订单 ${o.orderNo}`,
      `接单已超过 ${threshold} 分钟仍无人处理，按规则不再受理取消`,
      ...(o.cancelRequestNote ? [`顾客当时写的理由：${o.cancelRequestNote}`] : []),
      '订单继续制作。如需协商请主动联系顾客',
    ])
  }
  return n
}

/**
 * 报价保鲜（规格 §6b 保鲜第一层）：「备餐中 + 无在途配送单 + 报价早于 N 分钟」的单重查一次。
 * 备餐时长不固定（十分钟到半小时都有），报价会过时；查价免费不扣费，所以定时刷比在
 * 点呼叫时强制重查更好——最坏也就旧 N 分钟，而店员点下去的那一刻不会卡。
 *
 * 与其它任务不同，这里没有「每单只做一次」的标记列：保鲜本就要反复做，quotedAt 自己
 * 就是节流器（刚刷过的单下一轮不会再进候选）。
 */
export async function refreshStaleQuotes(min?: number): Promise<number> {
  const threshold = min ?? QUOTE_FRESH_MS / 60000
  const orders = await prisma.order.findMany({
    where: {
      deliveryType: 'LOCAL', status: 'PREPARING', cancelRequestedAt: null,
      receiverLatE6: { not: null }, receiverLngE6: { not: null },
      deliveries: { none: { activeOrderId: { not: null } } },
      OR: [{ quotedAt: null }, { quotedAt: { lt: ago(threshold) } }],
    },
    take: BATCH, select: { id: true },
  })
  let n = 0
  for (const o of orders) {
    try {
      if ((await refreshOrderQuote(o.id)).persisted) n++
    } catch (e) {
      // 查价是锦上添花：失败只记一行，绝不能让一单的报价问题拖垮整轮定时任务。
      console.warn('[refreshStaleQuotes] 订单', o.id, '重查报价失败，跳过:', (e as Error)?.message ?? e)
    }
  }
  return n
}

/**
 * 只呼最低价的单等太久无人接 → **取消 D-1、并呼建 D-2**（升级）。
 *
 * 为什么是「取消重呼」而不是「追加再呼一家」：`Delivery.activeOrderId` 唯一索引规定
 * 一张订单同时只允许一张在途配送单（schema.prisma），追加在结构上就不可能。
 * 好在 cancelDelivery + callRider 两条路径本来就都在，今天店员手动「取消呼叫 → 重新呼叫」
 * 走的就是它们，这里只是把同一套动作自动化。
 *
 * 升级**一步到位并呼全表**，不做「换第二便宜的再等 3 分钟」——再挑一轮就是 6 分钟，
 * 凉菜等不起（docs/design/workbench-ui-spec.md §6b）。
 *
 * 三道闸：
 *  - `escalateAfterMin <= 0`：店主关掉了自动升级，只留 callTimeoutMin 的人工提醒；
 *  - 熔断中：撤了旧单却呼不出新单，比不升级更糟——直接跳过，等人充值后点「恢复」；
 *  - 预估取消费 > 0：说明骑手多半已经接单了（未接单的单撤销不要钱）。这时自动撤单要真花钱，
 *    改标 `*_HELD` 交给人决定。这个标记同时让该行离开扫描范围，不会每分钟重复 precancel + 重复告警。
 *
 * 店主 2026-09-12 定的是**两级阶梯**（原三级去掉了「并呼全部」那一级）：
 *      第一次 自动挑最便宜的一家（或店员选「极速」只呼闪送）  →  第二次 并呼最便宜 N 家  →  到头
 * 按当前这一行的策略决定下一级（NEXT_RUNG）。升到 CHEAPEST 之后不再加人：
 * 三家都没人接再全呼多半也没人，白冻一笔 ¥75；改成到点**只发一次告警**叫人处理
 * （加小费 / 改自己送 / 取消）。告警的「只发一次」复用 callTimeoutRemindedAt 这一列——
 * 它本来就是「这张单的超时提醒发过了」的标记，remindCallTimeout 见到非空也不会再发第二遍。
 *
 * 升级扫描范围只含 SOLO / MANUAL。MANUAL 也在里面：店员手选的那一家没人接，
 * 菜一样做好了在等，没有理由不给它第二级（原来把它排除在外，理由是「不该在背后
 * 换掉店员的选择」——那会让手选的单永远停在第一级）。升级只在仍是 CALLING 且
 * 预估取消费为 0 时动手，不会撤掉已接单的骑手。
 *
 * 残余竞态：precancel 与 cancel 之间那约 1 秒里骑手恰好接单 → cancel 会真的取消已接单的骑手
 * 并产生约 ¥2 取消费。金额会落在 D-1 行的 cancelFee 上、事件里看得见；概率极低，接受并记录。
 */
export async function escalateSoloCalls(min?: number): Promise<number> {
  const s = await getLocalSettings()
  const threshold = min ?? s.callStrategy.escalateAfterMin
  if (threshold <= 0) return 0
  if (isCircuitTripped()) return 0
  // 第二级到头：并呼 N 家仍无人接 → 只提醒一次，不撤单不重呼。
  // 放在升级扫描之前、且不经过 precancel（那是一次外呼，到头的单没必要每分钟去问一次取消费）。
  const ended = await prisma.delivery.findMany({
    where: { status: 'CALLING', callStrategy: 'CHEAPEST', calledAt: { lt: ago(threshold) }, callTimeoutRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true, calledProviders: true },
  })
  for (const d of ended) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, callTimeoutRemindedAt: null }, data: { callTimeoutRemindedAt: new Date() } })
    if (marked.count === 0) continue
    notifyLocalDeliveryAlert('并呼多家仍无人接单', [
      `订单 ${d.orderNo}（已并呼 ${calledLabel(d.calledProviders)}）`,
      `等待超过 ${threshold} 分钟仍无人接单，阶梯已到头，不再自动加人`,
      '请到工作台处理：加小费、改自己送，或取消重呼',
    ], { key: `dlv-ladder-end:${d.id}` })
  }
  const rows = await prisma.delivery.findMany({
    where: {
      // providerTaskId 非空 = 运力方那头确实有单可撤（占位/UNKNOWN 行没有它，precancel 会 42234）
      status: 'CALLING', callStrategy: { in: ['SOLO', 'MANUAL'] }, providerTaskId: { not: null }, calledAt: { lt: ago(threshold) },
      // 顾客已经申请取消的单不许升级：callRider 对这个条件是硬拦截（42204），
      // 而 cancelDelivery 不拦——不排除的话会「先把 D-1 撤了、再在重呼那一步必然失败」，
      // 留下一条「请到工作台手动呼叫骑手」的告警，把店员引向与顾客意愿相反的操作。
      // 顾客可取消窗口（默认 5 分钟）与 3 分钟升级窗口高度重叠，这不是罕见路径。
      order: { cancelRequestedAt: null },
    },
    take: BATCH, select: { id: true, orderId: true, orderNo: true, deliveryNo: true, calledProviders: true, quotedFee: true, callStrategy: true },
  })
  let n = 0
  for (const d of rows) {
    try {
      const { cancelFeeFen } = await precancelDelivery(d.orderId)
      if ((cancelFeeFen ?? 0) > 0) {
        // HELD 标记跟着原策略走（SOLO→SOLO_HELD、CHEAPEST→CHEAPEST_HELD），这样事后还能
        // 分清「当时呼的是一家还是三家」；where 也带上原值，避免覆盖这一秒里被别人改过的行。
        const heldMark = HELD_OF[d.callStrategy as DeliveryCallStrategy]
        if (!heldMark) continue
        const held = await prisma.delivery.updateMany({
          where: { id: d.id, status: 'CALLING', callStrategy: d.callStrategy },
          data: { callStrategy: heldMark },
        })
        if (held.count === 0) continue   // 这一秒里被别人改了（接单/取消），下一轮自然不再命中
        await recordDeliveryEvent(prisma, {
          deliveryId: d.id, dedupeKey: adminEventKey(), source: 'SCHEDULER', operator: 'scheduler',
          statusDesc: `预估取消费 ¥${((cancelFeeFen ?? 0) / 100).toFixed(2)} > 0，放弃自动升级并呼（多半骑手已接单），请人工决定`,
        })
        notifyLocalDeliveryAlert('自动升级并呼已放弃', [
          `订单 ${d.orderNo}（${d.deliveryNo}，呼了 ${calledLabel(d.calledProviders)}${d.quotedFee != null ? ` ¥${(d.quotedFee / 100).toFixed(2)}` : ''}）`,
          `等待超过 ${threshold} 分钟，但预估取消费 ¥${((cancelFeeFen ?? 0) / 100).toFixed(2)}`,
          '撤单要花钱，已保留原呼叫。可继续等待、加小费或手动取消重呼',
        ])
        n++
        continue
      }
      // ⚠️ precancel 那一发是外呼（约 1 秒）。cancelDelivery 只收 orderId、内部按
      // 「当前在途单」定位，而我们是**按 d.id 这一行**做的决策——这 1 秒里若店员手动
      // 「取消呼叫 → 重新呼叫」换上了新的一张，下面这句会撤掉店员刚叫来的那个骑手
      // 并白扣一笔取消费。重新确认在途单还是同一行再动手，把窗口从「一次网络往返」
      // 压到「一次本地查询」。仍不是原子的，但代价与概率都降了两个量级。
      const stillSame = await getActiveDelivery(d.orderId)
      if (!stillSame || stillSame.id !== d.id) continue
      // 下一级：一家没人接 → 最便宜 N 家（两级到头，N 家没人接只提醒，见上面 ended）。
      // 挑谁交给 callRider/resolveCallProviders 按**当下**的报价现算（forceMode），
      // 不拿三分钟前那份名单——那三分钟里报价会变，运力表也可能被店主改过。
      const nextMode = NEXT_RUNG[d.callStrategy as DeliveryCallStrategy]
      if (!nextMode) continue
      const rungText = `并呼最便宜 ${s.callStrategy.cheapestN} 家`
      await cancelDelivery({ orderId: d.orderId, operator: 'scheduler', reason: `${threshold} 分钟无人接单，自动升级为${rungText}` })
      try {
        await callRider({
          orderId: d.orderId, operator: 'scheduler', source: 'SCHEDULER', forceMode: nextMode,
        })
        n++
      } catch (e) {
        // D-1 已经撤了、D-2 没呼出去：订单停在 PREPARING 且无在途单。remindLocalUncalled（10 分钟）
        // 会兜住，但那太晚了——菜已经做好在等。这里立刻喊一声。
        notifySystemAlert('自动升级并呼失败', [
          `订单 ${d.orderNo}：原配送单 ${d.deliveryNo} 已取消，但并呼未能发出`,
          (e as Error).message,
          '该订单当前无在途配送单，请到工作台手动呼叫骑手或改自己送',
        ], { key: `dlv-escalate:${d.id}` })
      }
    } catch (e) {
      // 单行失败不能拖垮整轮：最常见的是这一秒里骑手正好接了单（precancel/cancel 撞状态），
      // 属正常竞态，下一轮该行已不在 CALLING 里，自然不再命中。
      console.warn('[escalateSoloCalls] 配送单', d.deliveryNo, '升级失败，跳过:', (e as Error)?.message ?? e)
    }
  }
  return n
}

export async function autoCallRiders(delayMin?: number): Promise<number> {
  const s = await getLocalSettings()
  const delay = delayMin ?? s.autoCallDelayMin
  // 0 = 手动模式（店主默认，D6 拍板：接单与呼叫分开）。这道门必须留在函数自身，
  // 不能挪到「调用方是不是生产」那种外部条件上——否则将来任何一个新调用点都可能悄悄绕过它。
  // e2e 要验「立刻命中」时传 0.01 分钟（600ms），不要为了测试把这里的语义改成有条件的。
  if (delay <= 0) return 0
  if (!s.enabled || !isOpenNow(s)) return 0
  if (isCircuitTripped()) return 0
  const orders = await prisma.order.findMany({
    where: {
      deliveryType: 'LOCAL', scheduledAt: null, status: 'PREPARING', cancelRequestedAt: null,
      acceptedAt: { lt: ago(delay) },
      deliveries: { none: { activeOrderId: { not: null } } },
    },
    take: BATCH, select: { id: true },
  })
  let n = 0
  for (const o of orders) {
    try { await callRider({ orderId: o.id, operator: 'scheduler', source: 'SCHEDULER' }); n++ }
    catch (e) {
      // callRider 内部已按失败类型落库+告警，这里继续处理下一单；但吞掉异常本身不能是无声的——
      // 这里也会兜住第二层守卫抛出的 42204（候选查询和 callRider 内部复核之间的竞态）等任何未预期的问题，
      // 不打日志就是「可诊断」与「不可诊断」事故之间的差别。
      console.warn('[autoCallRiders] 呼叫订单', o.id, '失败，跳过:', (e as Error)?.message ?? e)
    }
  }
  return n
}

/**
 * LOCAL 单的自动确认收货兜底：既有 autoCompleteShippedOrders 走 shipment.shippedAt，
 * 而 LOCAL 单永不写 Shipment 行，所以它永远命中不了同城单。若 520 回调丢失，
 * 同城单会永久停在 SHIPPED 无人收尾。这里补两条（任一命中即收尾）：
 *  1) 配送单已取货超过 N 天（与邮寄单同一口径，纯按 pickedUpAt）；
 *  2) 配送单仍在 DELIVERING、且骑手接单已超过 deliveringTimeoutMin×3（兜底 6 小时）——
 *     同城一单顶多一两个小时，接单 6 小时还挂在「配送中」只可能是 520 丢了，等 N 天没有意义：
 *     期间配送单一直占着 activeOrderId，退款被 42221 挡住，顾客端也一直显示「配送中」。
 * 命中后订单置 COMPLETED，仍占位的配送单一并置 DELIVERED + 释放。
 */
export async function autoCompleteLocalDelivered(days?: number): Promise<number> {
  const d = days ?? config.order.autoCompleteDays
  const deadline = ago(d * 24 * 60)
  const s = await getLocalSettings()
  const stuckMin = Number.isFinite(s.deliveringTimeoutMin) && s.deliveringTimeoutMin > 0 ? s.deliveringTimeoutMin * 3 : 6 * 60
  const stuckDeadline = ago(stuckMin)
  const orders = await prisma.order.findMany({
    where: { deliveryType: 'LOCAL', status: 'SHIPPED' },
    select: {
      id: true,
      deliveries: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, pickedUpAt: true, acceptedAt: true, activeOrderId: true } },
    },
    take: BATCH,
  })
  let n = 0
  for (const o of orders) {
    const dlv = o.deliveries[0]
    if (!dlv) continue
    const byDays = !!dlv.pickedUpAt && dlv.pickedUpAt < deadline
    const byStuck = dlv.status === 'DELIVERING' && !!dlv.acceptedAt && dlv.acceptedAt < stuckDeadline
    if (!byDays && !byStuck) continue
    const moved = await prisma.order.updateMany({ where: { id: o.id, status: 'SHIPPED' }, data: { status: 'COMPLETED', completedAt: new Date() } })
    if (moved.count === 0) continue
    if (dlv.activeOrderId !== null) {
      // 与其它所有终态写入同一范式：上面读到的 status 只是快照，这几毫秒里回调/店员可能已把它
      // 置 CANCELLED/FAILED，无守卫会把一张已取消的单改写成 DELIVERED（取消费与「已送达」同时成立）
      await prisma.delivery.updateMany({ where: { id: dlv.id, status: { notIn: [...TERMINAL] } }, data: { status: 'DELIVERED', statusRank: 100, deliveredAt: new Date(), activeOrderId: null } })
    }
    n++
  }
  return n
}

export async function housekeepingDelivery(): Promise<number> {
  let n = 0
  const stuck = await prisma.delivery.findMany({ where: { status: { in: [...TERMINAL] }, activeOrderId: { not: null } }, take: BATCH, select: { id: true, deliveryNo: true, status: true } })
  for (const d of stuck) {
    await prisma.delivery.updateMany({ where: { id: d.id }, data: { activeOrderId: null } })
    notifySystemAlert('配送单数据不一致已自愈', [`${d.deliveryNo} 终态 ${DELIVERY_STATUS_LABEL[d.status] ?? d.status} 但仍占位，已释放`], { key: `dlv-housekeeping:${d.id}` })
    n++
  }
  // 陈旧 PENDING：占位行只应存在于一次外呼期间（最长 8 秒超时 + 落库）。超过 10 分钟还是 PENDING，
  // 说明进程在外呼后崩了、或 callRider 的恢复写本身失败（DB 曾不可达）。不扫的话该订单永久不可再呼。
  const stalePending = await prisma.delivery.findMany({ where: { status: 'PENDING', createdAt: { lt: ago(10) } }, take: BATCH, select: { id: true, deliveryNo: true, orderNo: true } })
  for (const d of stalePending) {
    const moved = await prisma.delivery.updateMany({ where: { id: d.id, status: 'PENDING' }, data: { status: 'FAILED', activeOrderId: null, errorCode: 'STALE', failReason: '呼叫未落库（进程中断或数据库异常），已自动释放' } })
    if (moved.count === 0) continue
    notifySystemAlert('配送单占位超时未落库已释放', [`订单 ${d.orderNo}（${d.deliveryNo}）`, '若运力方已产生真实单，请到快递100 后台核对'], { key: `dlv-stale:${d.id}` })
    n++
  }
  n += (await prisma.deliveryEvent.updateMany({
    where: { createdAt: { lt: new Date(Date.now() - 90 * 24 * 3600 * 1000) }, rawPayload: { not: Prisma.DbNull } },
    data: { rawPayload: Prisma.DbNull },
  })).count
  return n
}
