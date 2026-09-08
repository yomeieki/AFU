/**
 * 新订单微信推送（双通道，均可选，由 env 决定启用哪个）：
 * - 企业微信群机器人：ORDER_NOTIFY_WECOM_WEBHOOK（企微内部群 → 添加机器人 → 复制 webhook 地址）
 * - PushPlus：ORDER_NOTIFY_PUSHPLUS_TOKEN（+可选 ORDER_NOTIFY_PUSHPLUS_TOPIC 群组编码，发给整组）
 *
 * fire-and-forget：失败仅 console.warn 并重试一次，绝不 throw、绝不阻塞支付流程。
 */

import { sendWecomMarkdown, sendPushPlus, shouldSendAlert } from './notify'

interface NotifyOrderInfo {
  orderNo: string
  actualAmount: number // 分
  receiverName: string
  receiverPhone: string
  paidAt: Date
  /** 券抵扣额（分），M2 起有值 */
  discountAmount?: number
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
    `**🔔 新订单待发货**`,
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

/** 顾客在接单后宽限期内申请取消同城订单，需店员到工作台确认并退款。 */
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
  graceMin: number
): Promise<void> {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  // graceMin === 0 表示店主把窗口关掉了——此时顾客理应申请不了取消，
  // 旧文案「接单后即可申请」把这个「关闭」说成了「随时可申请」，语义正好反了
  const windowText = graceMin > 0 ? `接单后 ${graceMin} 分钟内` : '接单后不可申请（窗口已关闭）'
  const content = [
    `**🛵 同城订单：顾客申请取消（${windowText}，需确认全额退款）**`,
    `订单号：${order.orderNo}`,
    `金额：**¥${fmtYuan(order.actualAmount)}**`,
    `顾客：${order.receiverName} ${order.receiverPhone}`,
    ...(order.note ? [`原因：${order.note}`] : []),
    `请到后台「同城订单」处理`,
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, '同城订单申请取消', content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}

/**
 * 同城配送异常告警（呼叫失败/运力异常/回调超时等，orchestrator 调用）：店员双通道，自由行文本。
 * @param opts.key 可选限频键，走 notify.ts 的 shouldSendAlert 与 notifySystemAlert 共享同一套
 * 5 分钟同 key 抑制。不传就是原来的无限频行为——本函数原来完全没有去重，配合 autoCallRiders
 * 每分钟重试的场景（如运力异常 CAPACITY）会对同一个原因反复刷屏；调用方按需要传 key 才会变化，
 * 不传的既有调用点行为不受影响。被抑制期间的次数会拼进真正发出的那条消息里
 * （「（期间抑制 N 次）」），与 notifySystemAlert 的口径保持一致。
 */
export function notifyLocalDeliveryAlert(title: string, lines: string[], opts: { key?: string } = {}): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  let suppressedLine = ''
  if (opts.key) {
    const { send, suppressed } = shouldSendAlert(opts.key)
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

/** 低库存推送（定时任务，12 小时最多一次） */
export function notifyLowStock(products: { name: string; stock: number }[], threshold: number): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = [
    `**📉 库存预警（≤${threshold}）**`,
    ...products.map((p) => `- ${p.name}：剩 ${p.stock}${p.stock === 0 ? '（已售罄）' : ''}`),
    `请及时补货或在后台下架`,
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, `库存预警 ${products.length} 项`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}
