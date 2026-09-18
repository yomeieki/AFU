import { todayKey, fmtHHmm, fmtMonthDayTime } from './time.ts'
import type { Order } from '../types.ts'

/** 工作台看板还挂着的三个状态（PAID/PREPARING/SHIPPED）。REFUNDING/COMPLETED/CANCELLED/REFUNDED
 * 不在看板上，「去工作台」点过去也是死路，所以不出现。 */
export const ACTIVE_LOCAL_STATUSES = ['PAID', 'PREPARING', 'SHIPPED'] as const

/** 「去工作台」只挂在：同城/自取 + 下单日期是上海今天 + 状态还在工作台看板上 */
export function showWorkbenchLink(o: { deliveryType: string; status: string; createdAt: string }, now: Date): boolean {
  if (o.deliveryType !== 'LOCAL' && o.deliveryType !== 'PICKUP') return false
  if (!(ACTIVE_LOCAL_STATUSES as readonly string[]).includes(o.status)) return false
  return todayKey(new Date(o.createdAt)) === todayKey(now)
}

/** 商品摘要：'凉拌牛肉×1，红油毛肚[微辣]×2'；赠品行加「赠」前缀 */
export function itemsSummary(items: { productName: string; specText?: string | null; quantity: number; isGift?: boolean }[]): string {
  return items
    .map((it) => `${it.isGift ? '赠' : ''}${it.productName}${it.specText ? `[${it.specText}]` : ''}×${it.quantity}`)
    .join('，')
}

export function channelTag(deliveryType: string): { label: '外送' | '自取' | '邮寄'; tone: 'local' | 'pickup' | 'express' } {
  if (deliveryType === 'PICKUP') return { label: '自取', tone: 'pickup' }
  if (deliveryType === 'EXPRESS') return { label: '邮寄', tone: 'express' }
  return { label: '外送', tone: 'local' }
}

/**
 * 配送单状态的人话。**刻意与 `components/ui/StatusBadge.tsx` 的 `STATUS_MAP` 里配送单那一段
 * 重复**：本文件是纯逻辑（`node --test` 直接跑，闸门 A14 不许它 import 任何 `.tsx`），没法复用
 * 那张表。改配送单状态文案时两处都要改——目前状态集合（快递100 回调）已经稳定多年没变过。
 */
const DELIVERY_STATUS_LABEL: Record<string, string> = {
  PENDING: '待呼叫', CALLING: '待抢单', ACCEPTED: '骑手已接单', ARRIVING: '赶来取货',
  ARRIVED: '已到店', DELIVERING: '配送中', REASSIGNING: '改派中', ABNORMAL: '配送异常',
  DELIVERED: '已送达', CANCELLED: '已取消', FAILED: '呼叫失败', UNKNOWN: '状态未确认',
}

export type OrderListRow = Pick<Order, 'deliveryType' | 'status' | 'pickupAt' | 'pickupReadyAt' | 'completedAt' | 'shipment' | 'latestDelivery'>

/**
 * 宽屏第 7 列（配送·取餐）两行文字：
 *   LOCAL   → ['骑手 X' | '未呼叫', 配送单状态]
 *   PICKUP  → ['取餐 HH:mm', '已备好' | '已取走' | '']
 *   EXPRESS → ['公司 单号' | '未发货', 'M-DD HH:mm 发货' | '']
 */
export function deliveryColumn(o: OrderListRow, _now: Date): [string, string] {
  if (o.deliveryType === 'PICKUP') {
    const line1 = `取餐 ${fmtHHmm(o.pickupAt)}`
    const line2 = o.status === 'COMPLETED' ? '已取走' : o.pickupReadyAt ? '已备好' : ''
    return [line1, line2]
  }
  if (o.deliveryType === 'EXPRESS') {
    const s = o.shipment
    const line1 = s?.expressCompany && s?.expressNo ? `${s.expressCompany} ${s.expressNo}` : '未发货'
    const line2 = s?.shippedAt ? `${fmtMonthDayTime(s.shippedAt)} 发货` : ''
    return [line1, line2]
  }
  // LOCAL
  const d = o.latestDelivery
  const line1 = d?.courierName ? `骑手 ${d.courierName}` : '未呼叫'
  const line2 = d ? (DELIVERY_STATUS_LABEL[d.status] ?? d.status) : ''
  return [line1, line2]
}
