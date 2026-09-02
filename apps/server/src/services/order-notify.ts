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

/** 客户申请退款时通知员工（未接单订单的自助取消）。 */
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
    `**🔁 客户申请退款**`,
    `订单号：${order.orderNo}`,
    `金额：**¥${fmtYuan(order.actualAmount)}**`,
    `客户：${order.receiverName} ${order.receiverPhone}`,
    `请在后台「订单管理 → 退款」标签页点击「发起退款」，款项将原路退回客户微信`,
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
