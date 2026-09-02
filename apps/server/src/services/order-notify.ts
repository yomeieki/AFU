/**
 * 新订单微信推送（双通道，均可选，由 env 决定启用哪个）：
 * - 企业微信群机器人：ORDER_NOTIFY_WECOM_WEBHOOK（企微内部群 → 添加机器人 → 复制 webhook 地址）
 * - PushPlus：ORDER_NOTIFY_PUSHPLUS_TOKEN（+可选 ORDER_NOTIFY_PUSHPLUS_TOPIC 群组编码，发给整组）
 *
 * fire-and-forget：失败仅 console.warn 并重试一次，绝不 throw、绝不阻塞支付流程。
 */

import { sendWecomMarkdown, sendPushPlus } from './notify'

interface NotifyOrderInfo {
  orderNo: string
  actualAmount: number // 分
  receiverName: string
  receiverPhone: string
  paidAt: Date
}

interface NotifyItemInfo {
  productName: string
  specText?: string | null
  quantity: number
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
    return `- ${it.productName}${spec} × ${it.quantity}`
  })
  return [
    `**🔔 新订单待发货**`,
    `订单号：${order.orderNo}`,
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
