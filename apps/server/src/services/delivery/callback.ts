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

export async function handleKdCallback(deliveryNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }> {
  const rawBody = JSON.stringify(body)
  const delivery = await prisma.delivery.findUnique({
    where: { deliveryNo },
    include: { order: { include: {
      user: { select: { openid: true } },
      items: { select: { productName: true }, take: 1 },
    } } },
  })
  if (!delivery) {
    notifySystemAlert('快递100 回调查不到配送单', [`deliveryNo=${deliveryNo}`, '若此前有下单超时，可能是占位落库失败的孤儿单，请到快递100 后台核对'], { key: `kd-cb-miss:${deliveryNo}` })
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
  // 并呼假撤单过滤：多运力并呼时未中标运力也推 720；已锁定 taskId 且不匹配 → 不得终态化
  if (p.providerStatus === '720' && delivery.providerTaskId && p.taskId && p.taskId !== delivery.providerTaskId) {
    try {
      await recordDeliveryEvent(prisma, { deliveryId: delivery.id, dedupeKey: makeCallbackDedupeKey(deliveryNo, `720@${p.taskId}`, null, rawBody), source: 'CALLBACK', providerStatus: 720, statusDesc: `未中标运力撤单（taskId=${p.taskId}），忽略`, rawPayload: body })
    } catch { /* 同上 */ }
    if (delivery.statusRank < 20) notifySystemAlert('快递100 呼叫阶段收到 taskId 不匹配的 720', [`deliveryNo=${deliveryNo}`, `锁定=${delivery.providerTaskId} 回调=${p.taskId}`, '真实联调时请核实并呼语义（spec §5.4）'], { key: `kd-cb-720x:${deliveryNo}` })
    return { http: 200 }
  }
  const mapped = PROVIDER_STATUS_MAP[p.providerStatus]
  const updateTimeIso = p.providerUpdateTime ? p.providerUpdateTime.toISOString() : null
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
      // —— Order 联动（一律 LOCAL + 白名单 updateMany）——
      // 注：Order 无 shippedAt 列（LOCAL 单不写 Shipment 行），SHIPPED/回退 PREPARING 仅切换 status
      if (p.providerStatus === '310') {
        await tx.order.updateMany({ where: { id: delivery.orderId, deliveryType: 'LOCAL', status: 'PREPARING' }, data: { status: 'SHIPPED' } })
        const o = delivery.order
        after.push(() => sendDeliverSubscribeMessage(o.user.openid, { id: o.id, orderNo: o.orderNo }, { courierName: p.courierName ?? delivery.courierName, courierMobile: p.courierMobile ?? delivery.courierMobile }, o.items[0]?.productName))
      } else if (p.providerStatus === '520') {
        await tx.order.updateMany({ where: { id: delivery.orderId, deliveryType: 'LOCAL', status: { in: ['PREPARING', 'SHIPPED'] } }, data: { status: 'COMPLETED', completedAt: new Date() } })
      } else if (p.providerStatus === '720') {
        // 取货后被取消：SHIPPED 回退 PREPARING。
        // 与主动取消共用同一个实现（orchestrator.rollbackOrderAfterCancel），护栏只写一处
        const rolled = await rollbackOrderAfterCancel(tx, delivery.orderId)
        if (rolled === 0) {
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
