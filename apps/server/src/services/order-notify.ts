/**
 * 新订单微信推送（双通道，均可选，由 env 决定启用哪个）：
 * - 企业微信群机器人：ORDER_NOTIFY_WECOM_WEBHOOK（企微内部群 → 添加机器人 → 复制 webhook 地址）
 * - PushPlus：ORDER_NOTIFY_PUSHPLUS_TOKEN（+可选 ORDER_NOTIFY_PUSHPLUS_TOPIC 群组编码，发给整组）
 *
 * fire-and-forget：失败仅 console.warn 并重试一次，绝不 throw、绝不阻塞支付流程。
 */

import { sendWecomMarkdown, sendPushPlus, shouldSendAlert } from './notify'
import {
  buildLowStockChangeContent, buildLowStockDailyContent,
  type StockUnit as LowStockUnit, type AlertLevel as LowStockAlertLevel, type LowStockOverview,
} from './low-stock'
import type { LowStockSettings } from './low-stock-settings'

interface NotifyOrderInfo {
  orderNo: string
  actualAmount: number // 分
  receiverName: string
  receiverPhone: string
  paidAt: Date
  /** 券抵扣额（分），M2 起有值 */
  discountAmount?: number
  deliveryType?: string
  pickupSlotLabel?: string | null
  /** 预约送达时段文案（Task 8 的 buildContent 消费；本 Task 只加字段，接口先备齐） */
  scheduleSlotLabel?: string | null
}

interface NotifyItemInfo {
  productName: string
  specText?: string | null
  quantity: number
  /** M2：随单赠品。打包的人必须看到，漏发赠品跟漏发商品一样是事故 */
  isGift?: boolean
}

function fmtYuan(fen: number) {
  return (fen / 100).toFixed(2)
}

function fmtTime(d: Date) {
  return d.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
}

function buildContent(order: NotifyOrderInfo, items: NotifyItemInfo[]) {
  const lines = items.map((it) => {
    const spec = it.specText ? `（${it.specText}）` : ''
    // 赠品前缀不能省：它在订单里金额为 0，不标出来打包的人很容易当成「多出来的一行」跳过
    return `- ${it.isGift ? '【赠品】' : ''}${it.productName}${spec} × ${it.quantity}`
  })
  // PO 2026-09-06 定：**只显示抵扣额，不显示券名**。券名可能是「客服补偿」「配送延误赔偿」
  // 这类字样，打包员不需要知道这一单为什么被补偿过。
  const discountLine = order.discountAmount && order.discountAmount > 0
    ? [`已用券 −¥${fmtYuan(order.discountAmount)}`]
    : []
  return [
    order.deliveryType === 'PICKUP' ? `**🏪 自取新订单${order.pickupSlotLabel ? ` · ${order.pickupSlotLabel} 取` : ''}**`
      : order.deliveryType === 'LOCAL' ? (order.scheduleSlotLabel ? `**📅 同城预约单 · ${order.scheduleSlotLabel} 送达**` : `**🛵 同城新订单**`)
      : `**🔔 新订单待发货**`,
    `订单号：${order.orderNo}`,
    ...discountLine,
    `金额：**¥${fmtYuan(order.actualAmount)}**`,
    ...lines,
    `收货人：${order.receiverName} ${order.receiverPhone}`,
    `时间：${fmtTime(order.paidAt)}`,
  ].join('\n')
}

/** 客户自助取消（未接单）但自动退款发起失败时通知员工到后台重试。 */
export function notifyRefundRequest(order: {
  orderNo: string
  actualAmount: number
  receiverName: string
  receiverPhone: string
}): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = [
    `**🔁 客户申请退款（自动退款未成功，需人工重试）**`,
    `订单号：${order.orderNo}`,
    `金额：**¥${fmtYuan(order.actualAmount)}**`,
    `客户：${order.receiverName} ${order.receiverPhone}`,
    `请到后台「订单管理 → 退款」标签页点击「重试退款」，款项将原路退回客户微信`,
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) {
    sendPushPlus(pushplusToken, `退款申请 ¥${fmtYuan(order.actualAmount)}`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
  }
}

/** 顾客在接单后宽限期内申请取消同城/邮寄订单，需店员到工作台确认并退款。 */
export async function notifyCancelRequest(
  order: {
    orderNo: string
    actualAmount: number
    receiverName: string
    receiverPhone: string
    note?: string | null
  },
  // 窗口分钟数曾经是写死的字面量「5」，而真值是可配置的 acceptGraceMin（同城/邮寄各自后台可调）——
  // orders.ts 的 cancelWindowOf 每次都实时读它判定窗口，店主一旦改了这个数，这条推送若还硬编码
  // 旧值，就会把合法申请说成「超出窗口」，店员核对/驳回全靠误导文案。所以不在这里读配置，
  // 改成由调用方把它当次判窗口用的那个 graceMin 传进来——同城调用处传同城的，邮寄调用处传邮寄的。
  graceMin: number,
  // 同城/邮寄两个渠道的措辞不能共用一份「同城订单…」文案——邮寄单顾客看不到骑手也没有「同城」
  // 这个概念，误用同城口径会让店员去错工作台（同城工作台 vs 全国邮寄订单页）。
  channel: 'LOCAL' | 'EXPRESS' | 'PICKUP'
): Promise<void> {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  // graceMin === 0 表示店主把窗口关掉了——此时顾客理应申请不了取消，
  // 旧文案「接单后即可申请」把这个「关闭」说成了「随时可申请」，语义正好反了。
  // 调用方（orders.ts 的 cancel-request 路由）此刻传进来的 graceMin 实际必定 > 0——
  // 窗口关闭（cancelGraceMin<=0）时路由在更早处已经以 42229 拒绝了申请，走不到这条推送。
  // 这一支留作防御性兜底（万一以后哪个调用点忘了先判窗口再推送），不是当前会触发的正常路径。
  const windowText = channel === 'PICKUP'
    ? '备好之前可申请'
    : graceMin > 0 ? `接单后 ${graceMin} 分钟内` : '接单后不可申请（窗口已关闭）'
  const isExpress = channel === 'EXPRESS'
  const title = channel === 'PICKUP' ? '自取订单申请取消' : isExpress ? '邮寄订单申请取消' : '同城订单申请取消'
  const header = channel === 'PICKUP'
    ? `**🏪 自取订单：顾客申请取消（${windowText}，需确认全额退款）**`
    : isExpress
      ? `**📦 邮寄订单：顾客申请取消（${windowText}，需确认全额退款）**`
      : `**🛵 同城订单：顾客申请取消（${windowText}，需确认全额退款）**`
  const footer = channel === 'PICKUP' ? '请到后台「接单工作台」处理' : isExpress ? '请到后台「接单工作台」或「全国邮寄」订单页处理' : '请到后台「同城订单」处理'
  const content = [
    header,
    `订单号：${order.orderNo}`,
    `金额：**¥${fmtYuan(order.actualAmount)}**`,
    `顾客：${order.receiverName} ${order.receiverPhone}`,
    ...(order.note ? [`原因：${order.note}`] : []),
    footer,
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, title, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}

/**
 * 同城配送异常告警（呼叫失败/运力异常/回调超时等，orchestrator 调用）：店员双通道，自由行文本。
 * @param opts.key 可选限频键，走 notify.ts 的 shouldSendAlert 与 notifySystemAlert 共享同一套
 * 5 分钟同 key 抑制。不传就是原来的无限频行为——本函数原来完全没有去重，配合 autoCallRiders
 * 每分钟重试的场景（如运力异常 CAPACITY）会对同一个原因反复刷屏；调用方按需要传 key 才会变化，
 * 不传的既有调用点行为不受影响。被抑制期间的次数会拼进真正发出的那条消息里
 * （「（期间抑制 N 次）」），与 notifySystemAlert 的口径保持一致。
 */
export function notifyLocalDeliveryAlert(title: string, lines: string[], opts: { key?: string; windowMs?: number } = {}): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  let suppressedLine = ''
  if (opts.key) {
    const { send, suppressed } = shouldSendAlert(opts.key, opts.windowMs)
    if (!send) return
    if (suppressed > 0) suppressedLine = `\n> （期间抑制 ${suppressed} 次同类告警）`
  }
  const content = [`**🛵 ${title}**`, ...lines.map((l) => `> ${l}`)].join('\n') + suppressedLine
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, title, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}

/** 邮寄取件预约告警（揽货失败/快递100 取消/下单失败/余额不足/超时未接单/时段过未取件/待核对） */
export function notifyExpressAlert(title: string, lines: string[], opts: { key?: string } = {}): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  let suppressedLine = ''
  if (opts.key) {
    const { send, suppressed } = shouldSendAlert(opts.key)
    if (!send) return
    if (suppressed > 0) suppressedLine = `\n> （期间抑制 ${suppressed} 次同类告警）`
  }
  const content = [`**📦 ${title}**`, ...lines.map((l) => `> ${l}`)].join('\n') + suppressedLine
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, title, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}

/** 退款结果通知（微信回调或同步返回）。status: SUCCESS / ABNORMAL / CLOSED */
export function notifyRefundResult(
  order: { orderNo: string; receiverName: string; receiverPhone: string },
  refund: { amount: number; outRefundNo: string },
  status: 'SUCCESS' | 'ABNORMAL' | 'CLOSED'
): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const head =
    status === 'SUCCESS'
      ? '**✅ 退款已到账**'
      : status === 'ABNORMAL'
        ? '**⚠️ 退款异常（需到商户平台手动处理）**'
        : '**❌ 退款已关闭（未退成功，可重试）**'
  const content = [
    head,
    `订单号：${order.orderNo}`,
    `退款金额：**¥${fmtYuan(refund.amount)}**`,
    `退款单号：${refund.outRefundNo}`,
    `客户：${order.receiverName} ${order.receiverPhone}`,
    `时间：${fmtTime(new Date())}`,
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) {
    sendPushPlus(pushplusToken, `退款${status === 'SUCCESS' ? '成功' : '异常'} ¥${fmtYuan(refund.amount)}`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
  }
}

/** 支付成功后调用（mock 支付与微信回调两处）。不 await 也安全。 */
export function notifyOrderPaid(order: NotifyOrderInfo, items: NotifyItemInfo[]): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return

  const content = buildContent(order, items)

  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) {
    sendPushPlus(pushplusToken, `新订单 ¥${fmtYuan(order.actualAmount)}`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
  }
}

/** 打印彻底失败（重试耗尽转 FAILED）后的回退强化推送（规格 §8b：打印机是接单流程的单点，
 *  这是它唯一的兜底）。只对 NEW_ORDER 票用——CANCEL/REPEAT 等票即使打印失败，店员也已经从
 *  别的渠道（工作台/微信通知）知道这单的存在，不需要再单独推一条；NEW_ORDER 打印失败则可能
 *  意味着厨房完全不知道有这一单。文案带商品与地址，店主拿到就能直接派单，不用再打开后台查。 */
export function notifyPrintFailed(
  order: { orderNo: string; actualAmount: number; receiverName: string; receiverPhone: string; receiverFullAddress: string },
  items: NotifyItemInfo[]
): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const lines = items.map((it) => {
    const spec = it.specText ? `（${it.specText}）` : ''
    return `- ${it.productName}${spec} × ${it.quantity}`
  })
  const content = [
    `**⚠️ 打印失败，已改为推送（打印机故障期间请留意本条，人工确认是否已接单）**`,
    `订单号：${order.orderNo}`,
    `金额：**¥${fmtYuan(order.actualAmount)}**`,
    ...lines,
    `收货人：${order.receiverName} ${order.receiverPhone}`,
    `地址：${order.receiverFullAddress}`,
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) {
    sendPushPlus(pushplusToken, `打印失败，已改为推送 ¥${fmtYuan(order.actualAmount)}`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
  }
}

/** 顾客提交售后申请 → 通知员工到后台处理 */
export function notifyAfterSaleRequest(
  order: { orderNo: string; actualAmount: number; receiverName: string; receiverPhone: string },
  afterSale: { reasonLabel: string; description?: string | null; imageCount: number }
): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = [
    `**🛎 顾客申请售后**`,
    `订单号：${order.orderNo}`,
    `订单金额：**¥${fmtYuan(order.actualAmount)}**`,
    `原因：${afterSale.reasonLabel}${afterSale.imageCount ? `（附 ${afterSale.imageCount} 张图）` : ''}`,
    afterSale.description ? `说明：${afterSale.description.slice(0, 100)}` : '',
    `客户：${order.receiverName} ${order.receiverPhone}`,
    `请到后台「订单管理 → 售后」处理：同意并填退款金额，或拒绝并回复`,
  ]
    .filter(Boolean)
    .join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, `售后申请 ${order.orderNo}`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}

/** 已付款超 15 分钟未接单 → 催单（定时任务，每单一次） */
export function notifyAcceptReminder(
  orders: { orderNo: string; actualAmount: number; receiverName: string; receiverPhone: string; paidAt: Date | null }[]
): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const lines = orders
    .slice(0, 10)
    .map((o) => `- ${o.orderNo} ¥${fmtYuan(o.actualAmount)} ${o.receiverName}（付款 ${o.paidAt ? fmtTime(o.paidAt) : '-'}）`)
  const content = [
    `**⏰ ${orders.length} 单已付款超过 15 分钟仍未接单**`,
    ...lines,
    orders.length > 10 ? `…其余 ${orders.length - 10} 单` : '',
    `请尽快到后台接单备餐`,
  ]
    .filter(Boolean)
    .join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, `${orders.length} 单待接单催单`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}

/**
 * 库存预警（2026-09-24 起按规格判定，取代旧的商品总库存 ≤5、12 小时最多一次）：
 * 即时推送（低于 pushBelow / 卖到 0，去重在 services/low-stock.ts）与每日汇总各一个函数，
 * 文案都是 low-stock.ts 导出的纯函数——这里只负责按渠道开关决定发不发、往哪个通道投递。
 */
export function notifyLowStockChange(pushes: { unit: LowStockUnit; level: LowStockAlertLevel }[], s: LowStockSettings): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = buildLowStockChangeContent(pushes, s)
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, `库存告急 ${pushes.length} 项`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}

export function notifyLowStockDaily(overview: LowStockOverview, s: LowStockSettings): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = buildLowStockDailyContent(overview, s)
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, '今日库存清单', content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}

/** 自取：取餐时间过后仍没人点「已取走」（每单一次，pickupRemindedAt 记录） */
export function notifyPickupUnpicked(orders: { orderNo: string; receiverPhone: string; slotLabel: string }[]): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = [
    `**🏪 ${orders.length} 单自取已过取餐时间仍未取走**`,
    ...orders.slice(0, 10).map((o) => `- 尾号${o.receiverPhone.slice(-4)} · ${o.slotLabel}`),
    '顾客来取请在工作台点「已取走」；确认不来取可退款',
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, '自取单未取', content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}
/** 自取：超时自动完成（店员没点「已取走」，系统按取餐时间 + N 分钟收尾） */
export function notifyPickupAutoCompleted(orders: { orderNo: string; receiverPhone: string; slotLabel: string }[]): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = [
    `**🏪 ${orders.length} 单自取按超时自动完成**`,
    ...orders.slice(0, 10).map((o) => `- 尾号${o.receiverPhone.slice(-4)} · ${o.slotLabel}`),
    '如果顾客确实没来取，请到后台按售后/退款处理',
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, '自取单自动完成', content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}

/** 预约单到「接单截止」仍未接单的催单（schedule-tasks）。文案带送达时段，与立即单的「超过 15 分钟」区分 */
export function notifyScheduledAcceptReminder(
  orders: { orderNo: string; actualAmount: number; receiverName: string; receiverPhone: string; slotLabel: string }[]
): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const lines = orders.slice(0, 10).map((o) => `- ${o.orderNo} ¥${fmtYuan(o.actualAmount)} 尾号${o.receiverPhone.slice(-4)}（${o.slotLabel} 送达）`)
  const content = [`**📅 ${orders.length} 张预约单已到接单截止仍未接单**`, ...lines, orders.length > 10 ? `…其余 ${orders.length - 10} 单` : '', '请立即到工作台接单，备餐票已出/即将出'].filter(Boolean).join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, `${orders.length} 张预约单待接单`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}
