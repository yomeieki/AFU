/**
 * 订单操作按钮的显示规则——**一处判定，三处共用**（`pages/Orders.tsx`、`pages/LocalOrders.tsx`、
 * `components/orders/detail/DetailActions.tsx`）。
 *
 * 背景（2026-09-22）：同城订单页的「退款」只看「还可退金额 > 0」，不看状态，于是从未付款就
 * 取消的单也画出了退款按钮。服务端 `services/refund.ts` 的 `REFUNDABLE_STATUSES` 会把它拒掉，
 * 钱退不出去，但按钮本身在误导店员。三处各写一份规则就会这样慢慢漂移，所以收口到这里。
 *
 * 纯逻辑文件：`node --test` 直接跑，不许 import 任何 `.tsx`。
 */

/** 与服务端 `services/refund.ts` 的 REFUNDABLE_STATUSES 一致：能发起（首次或再次）退款的订单状态 */
export const REFUNDABLE_STATUSES = ['PAID', 'PREPARING', 'SHIPPED', 'COMPLETED'] as const

/** 与服务端 `services/refund.ts` 的 ACTIVE_REFUND_STATUSES 一致：这几种状态下不允许再发起一笔 */
export const ACTIVE_REFUND_STATUSES = ['PENDING', 'PROCESSING', 'ABNORMAL'] as const

/**
 * 这张单收到过钱吗。PENDING_PAYMENT 还没付；CANCELLED 恒为「没付款就取消」——
 * 取消后微信回调才到账的单，服务端会先转成 REFUNDING 再自动全额退（`routes/wechat-notify.ts`），
 * 不会停在 CANCELLED。所以凡是「必须有过一笔交易」的操作（退款、发赔偿券、重打小票）都以此为门槛。
 */
export function everPaid(o: { status: string }): boolean {
  return o.status !== 'PENDING_PAYMENT' && o.status !== 'CANCELLED'
}

/** 显示「退款 / 再退款」按钮：状态在可退集合里，且还有可退余额 */
export function canRefund(o: { status: string; remainingRefundable: number }): boolean {
  return (REFUNDABLE_STATUSES as readonly string[]).includes(o.status) && o.remainingRefundable > 0
}

/** 有一笔退款还在微信那边没落定（按钮要置灰，服务端也会以 42205 拒绝再发起） */
export function hasActiveRefund(o: { latestRefund?: { status: string } | null }): boolean {
  const r = o.latestRefund
  return !!r && (ACTIVE_REFUND_STATUSES as readonly string[]).includes(r.status)
}

/** 退过一部分就叫「再退款」 */
export function refundLabel(o: { refundedAmount: number }): '退款' | '再退款' {
  return o.refundedAmount > 0 ? '再退款' : '退款'
}

/**
 * 「重打小票」：只有出过票的单才有票可重打。从未付款的单（待付款 / 没付款就取消）从来没出过票，
 * 而 REPRINT 印出来的和新单票一模一样（`services/ticket/content.ts`），厨房拿到会当新单做——
 * 这是比退款按钮更实际的风险。
 */
export function canReprint(o: { status: string }): boolean {
  return everPaid(o)
}

/** 「发赔偿券」：只对有成功支付记录的单显示（M3 D2）；发券端点是用户维度的，所以还得有 userId */
export function canIssueCoupon(o: { status: string; userId?: number }): boolean {
  return o.userId !== undefined && everPaid(o)
}

/**
 * 「退款待处理」Tab 传给列表接口的伪状态（routes/admin/orders.ts 识别）。
 * 只列要人出手的单，正常退款中的单不出现——自动补查会把它们推到结局。
 */
export const REFUND_ATTENTION_FILTER = 'REFUND_ATTENTION'

/**
 * 这张退款中的单需要人出手吗。与服务端 REFUND_ATTENTION 的 where 同一条规则：
 * 订单在 REFUNDING，且没有一笔退款还在微信那边走（PENDING/PROCESSING）。
 * 命中的四种：没有退款记录 / ABNORMAL（去商户平台处理）/ CLOSED / FAILED（后台重试）。
 */
export function refundNeedsHuman(o: { status: string; latestRefund?: { status: string } | null }): boolean {
  if (o.status !== 'REFUNDING') return false
  const r = o.latestRefund
  return !(r && (r.status === 'PENDING' || r.status === 'PROCESSING'))
}

/** 退款中的单上那颗按钮的文案：有过记录叫「重试退款」，一条都没有叫「发起退款」 */
export function refundRetryLabel(o: { latestRefund?: { status: string } | null }): '重试退款' | '发起退款' {
  return o.latestRefund ? '重试退款' : '发起退款'
}

/**
 * 退款中的单旁边的状态提示。ABNORMAL 虽然在 ACTIVE_REFUND_STATUSES 里（服务端不许再发起），
 * 但对店员来说是「要去商户平台处理」，所以单独给文案。
 */
export function refundingHint(o: { latestRefund?: { status: string } | null }): '微信处理中' | '退款异常' | null {
  const r = o.latestRefund
  if (!r) return null
  if (r.status === 'PENDING' || r.status === 'PROCESSING') return '微信处理中'
  if (r.status === 'ABNORMAL') return '退款异常'
  return null
}
