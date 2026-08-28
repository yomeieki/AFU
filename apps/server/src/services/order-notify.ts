/**
 * 新订单微信推送（双通道，均可选，由 env 决定启用哪个）：
 * - 企业微信群机器人：ORDER_NOTIFY_WECOM_WEBHOOK（企微内部群 → 添加机器人 → 复制 webhook 地址）
 * - PushPlus：ORDER_NOTIFY_PUSHPLUS_TOKEN（+可选 ORDER_NOTIFY_PUSHPLUS_TOPIC 群组编码，发给整组）
 *
 * fire-and-forget：失败仅 console.warn 并重试一次，绝不 throw、绝不阻塞支付流程。
 */

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

async function postJson(url: string, body: unknown, label: string, retried = false): Promise<void> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  } catch (e) {
    if (!retried) {
      // 5 秒后重试一次
      setTimeout(() => {
        postJson(url, body, label, true).catch(() => undefined)
      }, 5000)
    } else {
      console.warn(`[order-notify] ${label} 推送失败（已重试）:`, (e as Error).message)
    }
  }
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
    `请到微信商户平台完成退款，然后在后台标记「退款完成」`,
  ].join('\n')
  if (wecom) void postJson(wecom, { msgtype: 'markdown', markdown: { content } }, '企微机器人')
  if (pushplusToken) {
    const body: Record<string, string> = {
      token: pushplusToken,
      title: `退款申请 ¥${fmtYuan(order.actualAmount)}`,
      content,
      template: 'markdown',
    }
    const topic = process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC
    if (topic) body.topic = topic
    void postJson('https://www.pushplus.plus/send', body, 'PushPlus')
  }
}

/** 支付成功后调用（mock 支付与微信回调两处）。不 await 也安全。 */
export function notifyOrderPaid(order: NotifyOrderInfo, items: NotifyItemInfo[]): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return

  const content = buildContent(order, items)

  if (wecom) {
    void postJson(wecom, { msgtype: 'markdown', markdown: { content } }, '企微机器人')
  }
  if (pushplusToken) {
    const body: Record<string, string> = {
      token: pushplusToken,
      title: `新订单 ¥${fmtYuan(order.actualAmount)}`,
      content,
      template: 'markdown',
    }
    const topic = process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC
    if (topic) body.topic = topic
    void postJson('https://www.pushplus.plus/send', body, 'PushPlus')
  }
}
