import { providerLabel } from './providers.ts'
import { AFTER_SALE_REASON_LABEL, AFTER_SALE_STATUS_LABEL } from '../types.ts'
import type { OrderDetail, DeliveryInfo, ExpressBookingView, RefundRecord } from '../types.ts'

/** 与 pages/Orders.tsx 原来的 REFUND_LABEL 同一份文案，搬到这里供列表与详情共用 */
export const REFUND_STATUS_LABEL: Record<string, string> = {
  PENDING: '已发起',
  PROCESSING: '微信处理中',
  SUCCESS: '已退款',
  ABNORMAL: '异常',
  CLOSED: '已关闭',
  FAILED: '发起失败',
}

export const COUPON_SOURCE_LABEL: Record<string, string> = {
  ADMIN: '店员发放',
  POINTS: '积分兑换',
  CAMPAIGN: '活动',
  NEWCOMER: '新客',
}

/**
 * 详情接口 `GET /orders/:id` 的 `refunds` 已按 `createdAt desc` 倒序返回，`[0]` 与列表接口
 * `latestRefund` 同一条口径；服务端没有直接给这个字段（需改 1），前端映射一次补上。
 */
export function withLatestRefund<T extends { refunds?: RefundRecord[] }>(o: T): T & { latestRefund: RefundRecord | null } {
  return { ...o, latestRefund: o.refunds?.[0] ?? null }
}

export function backTargetFor(deliveryType: string): '/orders/local' | '/orders/express' {
  return deliveryType === 'EXPRESS' ? '/orders/express' : '/orders/local'
}

export function channelLabel(deliveryType: string): '同城外送' | '到店自取' | '全国邮寄' {
  if (deliveryType === 'PICKUP') return '到店自取'
  if (deliveryType === 'EXPRESS') return '全国邮寄'
  return '同城外送'
}

export interface MoneyRow {
  key: string
  label: string
  hint?: string
  fen: number
  kind: 'plus' | 'minus' | 'total' | 'info'
}

type MoneyOrder = Pick<
  OrderDetail,
  | 'totalAmount'
  | 'packingFee'
  | 'pickupDiscountAmount'
  | 'promoDiscountAmount'
  | 'discountAmount'
  | 'shippingFee'
  | 'actualAmount'
  | 'refundedAmount'
  | 'remainingRefundable'
  | 'deliveryType'
  | 'coupon'
>

/**
 * 顺序与小票一致（services/ticket/content.ts）：商品小计 → 打包费 → 自取优惠 → 满减 →
 * 优惠券 → 运费（自取单没有这一行）→ 实付 → 已退 → 还可退。为 0 的优惠/费用行不出现；
 * 实付/已退/还可退恒出现（已退为 0 时也出现，方便对账）。
 */
export function moneyRows(o: MoneyOrder): MoneyRow[] {
  const rows: MoneyRow[] = []
  rows.push({ key: 'subtotal', label: '商品小计', fen: o.totalAmount, kind: 'plus' })
  if ((o.packingFee ?? 0) > 0) rows.push({ key: 'packing', label: '打包费', fen: o.packingFee!, kind: 'plus' })
  if ((o.pickupDiscountAmount ?? 0) > 0) rows.push({ key: 'pickupDiscount', label: '自取优惠', fen: o.pickupDiscountAmount!, kind: 'minus' })
  if ((o.promoDiscountAmount ?? 0) > 0) rows.push({ key: 'promo', label: '满减', fen: o.promoDiscountAmount!, kind: 'minus' })
  if ((o.discountAmount ?? 0) > 0) {
    const c = o.coupon
    const hint = c ? `${c.name} · ${COUPON_SOURCE_LABEL[c.source] ?? c.source}${c.issuedBy ? ' · ' + c.issuedBy : ''}` : undefined
    rows.push({ key: 'coupon', label: '优惠券', hint, fen: o.discountAmount!, kind: 'minus' })
  }
  if (o.deliveryType !== 'PICKUP') rows.push({ key: 'shipping', label: '运费', fen: o.shippingFee, kind: 'plus' })
  rows.push({ key: 'actual', label: '实付', fen: o.actualAmount, kind: 'total' })
  rows.push({ key: 'refunded', label: '已退', fen: o.refundedAmount, kind: 'minus' })
  rows.push({ key: 'remaining', label: '还可退', fen: o.remainingRefundable, kind: 'info' })
  return rows
}

/**
 * 全额退款（`refundedAmount >= actualAmount && actualAmount > 0`）→ 全部**付费**行标「已退」，
 * 赠品行（`isGift`）不标；其它情况（部分退款/未退款）一律不标——数据判断不了就不标。
 */
export function refundedLineFlags(o: Pick<OrderDetail, 'items' | 'refundedAmount' | 'actualAmount'>): boolean[] {
  const full = o.actualAmount > 0 && o.refundedAmount >= o.actualAmount
  return o.items.map((it) => full && !it.isGift)
}

export interface TimelineNode {
  at: string
  label: string
  detail?: string
  tone: 'ok' | 'warn' | 'bad' | 'muted'
}

type TimelineOrder = Pick<
  OrderDetail,
  | 'deliveryType'
  | 'status'
  | 'createdAt'
  | 'paidAt'
  | 'payment'
  | 'cancelRequestedAt'
  | 'cancelRequestNote'
  | 'acceptedAt'
  | 'pickupReadyAt'
  | 'completedAt'
  | 'cancelledAt'
  | 'cancelReason'
  | 'shipment'
  | 'refunds'
  | 'afterSales'
>

/**
 * 时间线节点：只用已存在的时间戳拼，按时间升序；不编造操作人（「接单」库里没有操作人字段，
 * 不显示）。渠道专属的节点（配送/取餐/物流）通过 `extra` 传入，因为它们来自另外两个接口
 * （`getOrderDelivery` / `getExpressBooking`），不在 `GET /orders/:id` 里。
 */
export function timelineNodes(
  o: TimelineOrder,
  extra: { delivery?: Pick<DeliveryInfo, 'provider' | 'calledAt' | 'acceptedAt' | 'pickedUpAt' | 'deliveredAt' | 'cancelledAt' | 'cancelReason' | 'courierName'> | null; booking?: Pick<ExpressBookingView, 'bookedAt' | 'acceptedAt' | 'pickedAt' | 'deliveredAt' | 'cancelledAt' | 'slotText'> | null }
): TimelineNode[] {
  const nodes: TimelineNode[] = []
  const push = (at: string | null | undefined, label: string, opts: { detail?: string; tone?: TimelineNode['tone'] } = {}) => {
    if (!at) return
    nodes.push({ at, label, detail: opts.detail, tone: opts.tone ?? 'ok' })
  }

  push(o.createdAt, '下单')
  push(o.paidAt, '支付成功', { detail: o.payment?.paymentType === 'WECHAT' ? '微信支付' : '模拟支付' })
  push(o.cancelRequestedAt, '顾客申请取消', { detail: o.cancelRequestNote ?? undefined, tone: 'warn' })
  push(o.acceptedAt, '接单')

  if (o.deliveryType === 'LOCAL') {
    const d = extra.delivery
    push(d?.calledAt, '呼叫骑手', { detail: d ? providerLabel(d.provider) : undefined })
    push(d?.acceptedAt, '骑手接单', { detail: d?.courierName ?? undefined })
    push(d?.pickedUpAt, '骑手取货')
    push(d?.deliveredAt, '已送达')
    push(d?.cancelledAt, '配送取消', { detail: d?.cancelReason ?? undefined, tone: 'warn' })
  }
  if (o.deliveryType === 'PICKUP') {
    push(o.pickupReadyAt, '已备好')
    if (o.status === 'COMPLETED') push(o.completedAt, '已取走')
  }
  if (o.deliveryType === 'EXPRESS') {
    const s = o.shipment
    push(s?.shippedAt, '已发货', { detail: s ? `${s.expressCompany ?? ''} ${s.expressNo ?? ''}`.trim() || undefined : undefined })
    const b = extra.booking
    push(b?.bookedAt, '预约取件', { detail: b?.slotText })
    push(b?.pickedAt, '快递已取件')
    push(b?.deliveredAt, '已签收')
    push(b?.cancelledAt, '预约取消', { tone: 'warn' })
  }
  if (o.deliveryType !== 'PICKUP') push(o.completedAt, '已完成')
  push(o.cancelledAt, '已取消', { detail: o.cancelReason ?? undefined, tone: 'bad' })

  for (const r of o.refunds ?? []) {
    const at = r.successTime ?? r.createdAt
    const amt = `¥${(r.amount / 100).toFixed(2)}`
    const isBad = r.status === 'FAILED' || r.status === 'ABNORMAL'
    // CLOSED 是终态（services/refund.ts markRefundClosed 置 activeOrderId:null，提示可在
    // 后台重试退款），不是「处理中」；单独标注，不然店员会一直以为它还在走。
    const label =
      r.status === 'SUCCESS' ? `退款 ${amt}` :
      isBad ? `退款失败 ${amt}` :
      r.status === 'CLOSED' ? `退款关闭 ${amt}` :
      `退款处理中 ${amt}`
    const detail = [r.reason, r.operator ?? '系统'].filter(Boolean).join(' · ')
    const tone: TimelineNode['tone'] = r.status === 'SUCCESS' ? 'ok' : isBad ? 'bad' : 'muted'
    nodes.push({ at, label, detail: detail || undefined, tone })
  }
  for (const a of o.afterSales ?? []) {
    push(a.createdAt, '售后申请', { detail: AFTER_SALE_REASON_LABEL[a.reason] })
    if (a.handledAt) {
      const detail = [AFTER_SALE_STATUS_LABEL[a.status], a.handledBy].filter(Boolean).join(' · ')
      nodes.push({ at: a.handledAt, label: '售后处理', detail: detail || undefined, tone: 'ok' })
    }
  }

  return nodes.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime())
}
