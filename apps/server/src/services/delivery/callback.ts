/**
 * 快递100 状态回调处理。应答语义与微信支付相反（决策 N5）：
 * 快递100 没有查单接口，回调是唯一事实来源——仅「数据库入库异常」返 500 让对方重推；
 * 查不到单/验签失败/重复/乱序/未知状态一律 200 停止重推，问题走告警人工兜底。
 * 处理顺序（勿调换）：查单 → 验签 → 并呼假撤单过滤 → 单事务[事件+推进+订单联动] → 事务后通知。
 */
import prisma from '../../utils/prisma'
import { getDeliveryProvider } from './provider'
import { PROVIDER_STATUS_MAP, TERMINAL } from './state'
import { recordDeliveryEvent, makeCallbackDedupeKey, trunc } from './events'
import { notifySystemAlert } from '../notify'
import { notifyLocalDeliveryAlert } from '../order-notify'
import { sendDeliverSubscribeMessage } from '../subscribe-message'
import { rollbackOrderAfterCancel } from './orchestrator'
import { settlePoints } from '../member/points'

const updateTimeIsoOf = (p: { providerUpdateTime: Date | null }) => p.providerUpdateTime ? p.providerUpdateTime.toISOString() : null

export async function handleKdCallback(deliveryNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }> {
  const rawBody = JSON.stringify(body)
  const delivery = await prisma.delivery.findUnique({
    where: { deliveryNo },
    include: { order: { include: {
      user: { select: { openid: true } },
      items: { select: { productName: true }, take: 1 },
    } } },
    // estimatedDeliveryAt 与 providerDistanceM 是配送通知算「预计到达」要的两个量
    // （见 subscribe-message.ts 的 estimateArrival）——include order 是整行，已经带上
    // estimatedDeliveryAt；providerDistanceM 在 delivery 本行上。
  })
  if (!delivery) {
    // B6-02：这条路由未鉴权（安全性只靠 per-单 salt），deliveryNo 又是 D<orderId>-<seq>
    // 这种易猜的格式——键里若带 deliveryNo，任何人构造一批互不相同的 deliveryNo 就能让
    // 每个键各自躲过 5 分钟同键抑制，把告警刷爆、淹没真实告警。改成固定键，同一窗口内
    // 无论访问多少个不同 deliveryNo 都只发一条；notifySystemAlert 自带的「期间抑制 N 次」
    // 已经是本窗口内的计数，不用再自己维护一份。
    notifySystemAlert('快递100 回调查不到配送单', [`deliveryNo=${deliveryNo}`, '若此前有下单超时，可能是占位落库失败的孤儿单，请到快递100 后台核对'], { key: 'kd:unknown-delivery' })
    return { http: 200 }
  }
  const parsed = getDeliveryProvider().verifyAndParseCallback(body, delivery.callbackSalt)
  if (!parsed.ok) {
    // 不落 rawPayload：这条路由未鉴权（安全性只靠 per-单 salt），deliveryNo=D<orderId>-<seq> 易猜，
    // 验签失败又不去重同一条 body（dedupeKey=md5(rawBody)，body 一变就是新行），谁都能用它当免费写入点，
    // 单条 body 最大能塞进 express.urlencoded 的 100KB 上限。告警才是这里真正要的信号，
    // payload 留不留都不影响止损；不留能把每次失败的落地成本从「~100KB」砍到「一行小事件」。
    try {
      await recordDeliveryEvent(prisma, { deliveryId: delivery.id, dedupeKey: makeCallbackDedupeKey(deliveryNo, 'BAD', null, rawBody), source: 'CALLBACK', statusDesc: parsed.reason === 'SIGN_MISMATCH' ? '回调验签失败' : '回调格式异常' })
    } catch { /* 留痕失败不升级：这不是业务事件丢失 */ }
    notifySystemAlert('快递100 回调验签失败', [`deliveryNo=${deliveryNo}`], { key: `kd-cb-sign:${deliveryNo}` })
    return { http: 200 }
  }
  const p = parsed.payload
  // 未认领占位单上的 720：下单超时留下的 UNKNOWN 单 providerTaskId 为 null，下面那条「taskId 不匹配」
  // 过滤在它身上恒为 false；而并呼时未中标运力也会推 720，此刻根本分不清这是中标方撤单还是输家的
  // 并呼撤单。终态化的代价是不对称的：判错会把占位单 CANCELLED + 释放，中标骑手后续的 100/310/520
  // 全部撞 TERMINAL 被静默丢弃，店员再呼一次就是两个骑手两笔配送费。所以这里只留痕 + 告警，
  // 不改状态、不认领 taskId（用一条撤单事件去认领 taskId 本身就是错的），交给人到快递100 后台核对：
  // 确无活单 → 看板作废；有活单 → 等其后续回调认领。
  if (p.providerStatus === '720' && !delivery.providerTaskId) {
    try {
      await recordDeliveryEvent(prisma, { deliveryId: delivery.id, dedupeKey: makeCallbackDedupeKey(deliveryNo, '720@unclaimed', updateTimeIsoOf(p), rawBody), source: 'CALLBACK', providerStatus: 720, statusDesc: `未认领配送单收到撤单（taskId=${p.taskId || '空'}），不终态化，待人工核对`, rawPayload: body })
    } catch { /* 同上 */ }
    notifySystemAlert('未认领的配送单收到撤单回调', [
      `deliveryNo=${deliveryNo}（订单 ${delivery.orderNo}，当前 ${delivery.status}）`,
      `回调 taskId=${p.taskId || '空'}；本地尚未锁定 taskId，无法分辨是中标方撤单还是并呼中未中标方的撤单`,
      '未改动配送单状态。请到快递100 后台核对：确无活单则在看板作废重呼；有活单则等其后续回调认领',
    ], { key: `kd-cb-720-unclaimed:${delivery.id}` })
    return { http: 200 }
  }
  // 并呼假撤单过滤：多运力并呼时未中标运力也推 720。快递100 的 taskId 是**批次级**的——
  // 同批次所有被呼运力共享同一个 taskId（docs/research/2026-09-03-kuaidi100-same-city-api.md
  // :174,181,238-244），真正区分「这条 720 是谁的」的字段是 kuaidicom（即下面的 p.courierCompany，
  // verifyAndParseCallback 已从 param.kuaidicom 解出，见 kd100.ts:227）。
  //
  // 复核（opus）指出上一版有两条比原缺陷更糟的卡死路径，这版按「只在能正面证明这条 720
  // 属于非相关方时才忽略，证明不了就按真撤单处理」重写：
  //  (1) 上一版用 `statusRank>=20 时的 courierCompany` 当唯一判据，呼叫阶段（rank<20）恒为
  //      null → `!lockedWinner` 恒真 → 一律只留痕不终态化。生产默认 SOLO_LOWEST 只呼一家，
  //      呼叫阶段收到的 720 必然是这唯一一家自己的真撤单，却被当假撤单晾着：配送单卡在
  //      CALLING 不放、activeOrderId 不释放，escalateSoloCalls 3 分钟后对已取消单
  //      precancel/cancel 报错，被 tasks.ts:249 的 catch 静默吞掉、每分钟空转；店员
  //      cancel/selfDeliver/addTip 三条出口全部要外呼，也全废——订单永久卡 PREPARING。
  //      现在补一条「只呼了一家」的判据（soleCalled，来自 Delivery.calledProviders，
  //      orchestrator.ts:165 落库，tasks.ts:20 已有解析先例）：呼叫阶段只有一个候选，
  //      它自己撤单没有二义性，不用等 rank>=20 才敢认。
  //  (2) rank>=20 但 courierCompany 这一列本身为 null（推进 rank 的那条回调没带 kuaidicom，
  //      真实形态，见下面 e2e.sh 缺字段 310 用例）时，上一版直接把它当「未中标」忽略——
  //      写不上是「不知道该由谁撤」，不是「知道不是它」，这两者代价不对称，不能划等号。
  //      现在 `lockedWinner` 只在这一列真写上了才算「已锁定」；写不上时退到 soleCalled，
  //      两者都拿不到（多家并呼 + 未锁定）才是真的「说不清」，只有这一档才留痕不终态化，
  //      且下面加了自愈：呼叫过的每一家都各自推过 720 时不用死等人工核对。
  if (p.providerStatus === '720' && delivery.providerTaskId) {
    const called = Array.isArray(delivery.calledProviders)
      ? delivery.calledProviders.filter((x): x is string => typeof x === 'string') : []
    // 中标方：rank>=20 且这一列真写上了才算「已锁定」；写不上是「未知」，不能当「未中标」
    const lockedWinner = delivery.statusRank >= 20 ? delivery.courierCompany : null
    // 只呼了一家：这一家就是唯一可能的撤单方，呼叫阶段的 720 也无歧义
    const soleCalled = called.length === 1 ? called[0] : null
    const expected = lockedWinner ?? soleCalled            // null = 真不知道该由谁撤
    const mismatchByTaskId = !!p.taskId && p.taskId !== delivery.providerTaskId
    const mismatchByCourier = !!expected && !!p.courierCompany && p.courierCompany !== expected
    // 说不清归属的只剩：多家并呼 + 尚未锁定中标方。此时才只留痕
    let ambiguous = !expected && called.length > 1
    if (mismatchByTaskId || mismatchByCourier || ambiguous) {
      const kcDesc = `kuaidicom=${p.courierCompany || '空'}`
      if (ambiguous) {
        try {
          await recordDeliveryEvent(prisma, { deliveryId: delivery.id, dedupeKey: makeCallbackDedupeKey(deliveryNo, `720amb@${p.courierCompany || 'unknown'}`, null, rawBody), source: 'CALLBACK', providerStatus: 720, statusDesc: `多家并呼撤单（${kcDesc}），尚无中标方，不终态化，待人工核对`, rawPayload: body })
        } catch { /* 同上 */ }
        // 自愈：呼叫过的每一家运力各自都推过一次 720（distinct kuaidicom）时，说明这批
        // 运力全撤了，不再是「说不清归属」，放行给下面走真撤单终态化，不用死等人工核对。
        // DeliveryEvent 没有专门列存 kuaidicom，退而求其次数上面刚落库的 statusDesc 文案里
        // 的 kuaidicom——如果以后加了专门列，这里应该改成查那一列而不是文本匹配。
        const events = await prisma.deliveryEvent.findMany({
          where: { deliveryId: delivery.id, providerStatus: 720, statusDesc: { startsWith: '多家并呼撤单（' } },
          select: { statusDesc: true },
        })
        const seen = new Set<string>()
        for (const e of events) {
          const m = e.statusDesc?.match(/kuaidicom=([^）)]+)/)
          if (m && m[1] !== '空') seen.add(m[1])
        }
        if (called.length > 0 && seen.size >= called.length) ambiguous = false   // 全员撤单，落到下面按真撤单处理
      } else {
        try {
          await recordDeliveryEvent(prisma, { deliveryId: delivery.id, dedupeKey: makeCallbackDedupeKey(deliveryNo, `720x@${p.courierCompany || p.taskId || 'unknown'}`, null, rawBody), source: 'CALLBACK', providerStatus: 720, statusDesc: `未中标运力撤单（${kcDesc}，中标=${expected}），忽略`, rawPayload: body })
        } catch { /* 同上 */ }
      }
      if (ambiguous) {
        notifySystemAlert('快递100 并呼撤单归属不明', [
          `deliveryNo=${deliveryNo}（订单 ${delivery.orderNo}，当前 ${delivery.status}）`,
          `多家并呼中收到撤单（${kcDesc} taskId=${p.taskId || '空'}），尚无中标方，无法判断归属；运力方可能已无活单，请到快递100 后台核对后在工作台取消重呼`,
        ], { key: `kd-cb-720x:${deliveryNo}` })
        return { http: 200 }
      }
      if (mismatchByTaskId || mismatchByCourier) {
        // 呼叫阶段（还没锁定中标方）收到的 taskId/kuaidicom 不匹配才提醒——一旦锁定，
        // 已知输家迟到的 720 不必打扰店员，静默留痕即可（同上一版行为）
        if (delivery.statusRank < 20) {
          notifySystemAlert('快递100 呼叫阶段收到疑似未中标方 720', [`deliveryNo=${deliveryNo}`, `中标=${expected || '尚未锁定'} 回调 ${kcDesc} taskId=${p.taskId || '空'}`, '真实联调时请核实并呼语义（spec §5.4）'], { key: `kd-cb-720x:${deliveryNo}` })
        }
        return { http: 200 }
      }
      // 走到这里必然是 ambiguous 自愈成功：不再拦截，往下按真撤单终态化
    }
  }
  const mapped = PROVIDER_STATUS_MAP[p.providerStatus]
  const updateTimeIso = updateTimeIsoOf(p)
  const dedupeKey = makeCallbackDedupeKey(deliveryNo, p.providerStatus, updateTimeIso, rawBody)
  const n = Number(p.providerStatus)
  const providerStatusNum = Number.isFinite(n) ? n : null
  const after: (() => void)[] = []   // 事务后才发的通知（事务里发会在回滚时误报）
  try {
    await prisma.$transaction(async (tx) => {
      const ev = await recordDeliveryEvent(tx, { deliveryId: delivery.id, dedupeKey, source: 'CALLBACK', providerStatus: providerStatusNum, statusDesc: p.statusDesc, courierName: p.courierName, courierMobile: p.courierMobile, providerUpdateTime: updateTimeIso, rawPayload: body })
      if (ev.duplicate) return
      await tx.delivery.updateMany({ where: { id: delivery.id }, data: { lastCallbackAt: new Date() } })
      // UNKNOWN 认领：下单超时的占位单，第一个到达的回调即认领 taskId（ghost 消解，spec §5.4）
      if (delivery.status === 'UNKNOWN' && !delivery.providerTaskId && p.taskId) {
        await tx.delivery.updateMany({ where: { id: delivery.id, providerTaskId: null }, data: { providerTaskId: p.taskId } })
      }
      if (!mapped) {
        after.push(() => notifySystemAlert('快递100 未知回调状态', [`deliveryNo=${deliveryNo} status=${p.providerStatus}`, p.statusDesc ?? ''], { key: `kd-cb-unknown:${p.providerStatus}` }))
        return
      }
      const courierData = {
        ...(p.courierCompany ? { courierCompany: p.courierCompany } : {}),
        ...(p.courierName ? { courierName: p.courierName } : {}),
        ...(p.courierMobile ? { courierMobile: p.courierMobile } : {}),
        ...(p.statusDesc ? { statusDesc: p.statusDesc } : {}),
        ...(providerStatusNum !== null ? { providerStatus: providerStatusNum } : {}),
      }
      let moved = 0
      if (mapped.type === 'rank') {
        const r = await tx.delivery.updateMany({
          where: { id: delivery.id, statusRank: { lt: mapped.rank }, status: { notIn: [...TERMINAL] } },
          data: { status: mapped.status, statusRank: mapped.rank, ...(mapped.rank === 100 ? { activeOrderId: null } : {}), ...(mapped.stamp ? { [mapped.stamp]: new Date() } : {}), ...courierData },
        })
        moved = r.count
        // N8：改派中收到 100 允许 rank 回拨到 ACCEPTED（新骑手接单）。720 回退之外唯一的第二个回拨。
        if (moved === 0 && p.providerStatus === '100') {
          const r2 = await tx.delivery.updateMany({ where: { id: delivery.id, status: 'REASSIGNING' }, data: { status: 'ACCEPTED', statusRank: 20, acceptedAt: new Date(), ...courierData } })
          moved = r2.count
        }
      } else if (mapped.status === 'CANCELLED') {
        const r = await tx.delivery.updateMany({ where: { id: delivery.id, status: { notIn: [...TERMINAL] } }, data: { status: 'CANCELLED', activeOrderId: null, cancelledAt: new Date(), cancelReason: trunc(p.statusDesc, 255) ?? '运力方取消', ...courierData } })
        moved = r.count
      } else {   // REASSIGNING / ABNORMAL：旁路态不写 rank、不释放
        const r = await tx.delivery.updateMany({ where: { id: delivery.id, status: { notIn: [...TERMINAL] } }, data: { status: mapped.status, ...courierData } })
        moved = r.count
      }
      if (moved === 0) {
        // moved===0 盖住两件性质完全不同的事：良性的迟到/乱序包，以及「运力方仍有一张活单，
        // 而我们已经把它一笔勾销」。后者恰恰是文件头写的「回调是唯一事实来源」最该抓住的信号：
        // 本地行是 FAILED（从未在运力方那头取消过——不是我们主动 cancel，也不是运力方推的 720），
        // 而回调却说 rank>=20（真有骑手接了单/取货/送达），说明误作废后又被重呼，第二个骑手来了。
        // 不对 CANCELLED 告警：那是我们主动取消，尾随回调本就预期之内。
        if (delivery.status === 'FAILED' && mapped.type === 'rank' && mapped.rank >= 20) {
          after.push(() => notifySystemAlert('已作废的配送单收到运力方在途回调', [
            `deliveryNo=${deliveryNo}（订单 ${delivery.orderNo}）`,
            `回调状态=${p.providerStatus}（${p.statusDesc ?? ''}），说明运力方那头其实仍有一张活单`,
            '本地已判定作废（人工作废/落库失败释放等），大概率已重呼产生第二个骑手，请立即人工核对',
          ], { key: `kd-cb-ghost-active:${delivery.id}` }))
        }
        return   // 乱序迟到包：事件已留痕，不动状态、不联动订单
      }
      // ── actualFee 认领：中标运力确定之后，把它那一笔预扣写成本单的实扣 ──
      // 2026-09-06 首单证实了这个等式：快递100 企业后台四行扣费明细（闪送 ¥23.32「已支付」，
      // 其余三家「未支付」）与库里 quote_snapshot 的四家报价四比四全中，实扣 = 中标方报价。
      // 快递100 **没有任何查单/查费接口**（实打 11 个方法名全部「找不到该method」），
      // 所以不认领的话这一列永远是 NULL，对账只能靠人去后台抄。
      //
      // 为什么卡在 rank>=20 而不是 `0`：并呼时 `0` 回调带的 kuaidicom 不一定是最终中标那家
      // （:166 会把它写进 courierCompany，等 `100` 到了再覆盖）。实扣只能在「谁接了」确定之后写。
      // 写一次为准（where actualFee:null）：后续 230/310/520 再来也不改。
      if (moved > 0 && mapped.type === 'rank' && mapped.rank >= 20) {
        // 本次回调带了运力就用本次的；没带则只在**本地已经越过 100** 时才敢用行上那份
        // （statusRank>=20 说明它是被某个 rank>=20 的回调写进去的，不是 `0` 那次的并呼噪声）。
        const winner = p.courierCompany || (delivery.statusRank >= 20 ? delivery.courierCompany : null)
        if (winner) {
          const findFee = (v: unknown): number | null => {
            const arr = Array.isArray(v) ? v : null
            const hit = arr?.find((q) => (q as { provider?: unknown })?.provider === winner) as { feeFen?: unknown } | undefined
            return typeof hit?.feeFen === 'number' ? hit.feeFen : null
          }
          // orderFees（下单那一刻的真预扣）优先于 quoteSnapshot（呼叫前 ≤5 分钟的免费查价）
          const booked = findFee(delivery.orderFees)
          const quoted = findFee((delivery.quoteSnapshot as { quotes?: unknown } | null)?.quotes)
          const fee = booked ?? quoted
          if (fee != null) {
            await tx.delivery.updateMany({ where: { id: delivery.id, actualFee: null }, data: { actualFee: fee } })
            // 两个来源都有且差得多：说明「下单预扣 = 呼叫前报价」这个前提在动摇，
            // 对账口径要重新看。信息级——钱已经按预扣那份记对了，不必半夜叫人。
            if (booked != null && quoted != null && Math.abs(booked - quoted) > 50) {
              after.push(() => notifySystemAlert('下单预扣与呼叫前报价不一致', [
                `${deliveryNo}（订单 ${delivery.orderNo}）中标 ${winner}`,
                `下单预扣 ¥${(booked / 100).toFixed(2)} vs 呼叫前报价 ¥${(quoted / 100).toFixed(2)}`,
                '已按下单预扣记入实扣；若反复出现，对账口径需要复核',
              ], { key: `dlv-fee-drift:${delivery.id}` }))
            }
          } else if (delivery.actualFee === null) {
            after.push(() => notifySystemAlert('中标运力不在预扣/报价快照中', [
              `${deliveryNo}（订单 ${delivery.orderNo}）中标运力 ${winner}`,
              '下单预扣与报价快照里都找不到这家的金额，本单实扣无法自动记账',
              '请到快递100 企业后台抄回实扣金额（次月账单异议窗口只有 5 个工作日）',
            ], { key: `dlv-actual-fee-miss:${delivery.id}` }))
          }
        }
      }
      // —— Order 联动（一律 LOCAL + 白名单 updateMany）——
      // 注：Order 无 shippedAt 列（LOCAL 单不写 Shipment 行），SHIPPED/回退 PREPARING 仅切换 status
      if (p.providerStatus === '310') {
        await tx.order.updateMany({ where: { id: delivery.orderId, deliveryType: 'LOCAL', status: 'PREPARING' }, data: { status: 'SHIPPED' } })
        const o = delivery.order
        after.push(() => sendDeliverSubscribeMessage(
          o.user.openid,
          { id: o.id, orderNo: o.orderNo, estimatedDeliveryAt: o.estimatedDeliveryAt },
          {
            courierName: p.courierName ?? delivery.courierName,
            courierMobile: p.courierMobile ?? delivery.courierMobile,
            providerDistanceM: delivery.providerDistanceM,
          },
          o.items[0]?.productName,
        ))
      } else if (p.providerStatus === '520') {
        await tx.order.updateMany({ where: { id: delivery.orderId, deliveryType: 'LOCAL', status: { in: ['PREPARING', 'SHIPPED'] } }, data: { status: 'COMPLETED', completedAt: new Date() } })
        // 会员积分（M1）：同城配送完成也要发分，事务提交后才触发（settlePoints 自己会重新
        // 读一次订单状态，即使上面这次 updateMany 是无效的 0 行也安全）
        after.push(() => void settlePoints(delivery.orderId))
      } else if (p.providerStatus === '720') {
        // 取货后被取消：SHIPPED 回退 PREPARING。
        // 与主动取消共用同一个实现（orchestrator.rollbackOrderAfterCancel），护栏只写一处
        const { rolled, wasShipped } = await rollbackOrderAfterCancel(tx, delivery.orderId)
        // B3-03：并呼撤单/呼叫阶段就取消等路径下，订单调用前本就不是 SHIPPED（货没出门），
        // 此时回退 0 行是正常路径，不告警。只有调用前确实 SHIPPED 却仍回退不了（多半是
        // 在途退款/售后挡住）才是需要人工核对的真异常——同 cancelDelivery 的判定口径。
        if (wasShipped && rolled === 0) {
          // 假成功的另一半（照 cancelDelivery 的先例）：配送单已经真的 CANCELLED，
          // 但订单没能回退（多半是有在途退款/售后挡住）。不告警的话订单会静默停在 SHIPPED
          // 且无在途配送单，谁都不知道要去核对。
          after.push(() => notifySystemAlert('配送单取消回调到达但订单未回退', [
            `订单 ${delivery.orderNo}（${deliveryNo}）`,
            '运力方已取消配送，但订单未能回退到备餐中（可能存在在途退款/售后），请人工核对订单状态',
          ], { key: `dlv-cb-720-order-stuck:${delivery.id}` }))
        }
        after.push(() => notifyLocalDeliveryAlert('配送单被取消', [`订单 ${delivery.orderNo}`, p.statusDesc ?? '运力方取消', '请重新呼叫骑手或改自己送']))
      }
      if (p.providerStatus === '510') after.push(() => notifyLocalDeliveryAlert('配送异常', [`订单 ${delivery.orderNo}`, p.statusDesc ?? '', '请联系骑手/顾客确认']))
      if (p.providerStatus === '515') after.push(() => notifyLocalDeliveryAlert('骑手改派中', [`订单 ${delivery.orderNo}`, '平台正在重新分配骑手']))
    })
  } catch (e) {
    // 这里**不能**再对 P2002 返 200：dedupeKey 的重复已由 recordDeliveryEvent 自己吃掉并返回
    // {duplicate:true}，永远不会抛到这层。能抛到这层的 P2002 只可能是 UNKNOWN 认领时
    // providerTaskId 撞了另一条配送单的唯一索引——那正是最需要人知道的情形，
    // 返 200 会让事实永久丢失（无查单接口，回调是唯一事实来源）。
    console.error('[kd-callback] 入库失败:', e)
    notifySystemAlert('快递100 回调入库失败', [`deliveryNo=${deliveryNo} status=${p.providerStatus}`, (e as Error).message, '已返回 500 请求重推；若持续失败请人工核对配送单'], { key: `kd-cb-persist:${deliveryNo}` })
    return { http: 500 }   // N5：唯一返 500 的情形——让快递100 重推，这是无查单接口下仅有的补偿
  }
  for (const fn of after) { try { fn() } catch (e) { console.warn('[kd-callback] 通知失败:', (e as Error).message) } }
  return { http: 200 }
}
