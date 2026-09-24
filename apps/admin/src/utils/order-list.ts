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
 * 渠道配色——原是 `components/orders/OrderListTable.tsx` 里的模块私有 `CHANNEL_TONE`，
 * 2026-09-24 提升为这里的导出常量，供用户管理订单弹窗复用。**全仓库只此一份**：
 * 同城=橙、邮寄=蓝、自取=青，与订单列表、详情页、工作台三处既有语义一致（详情页那份
 * `DetailHero.CHANNEL_TONE` 键是大写的 deliveryType，与这里的小写 tone 键不是同一张表，
 * 两处不合并——合并需要改 DetailHero 的调用点，不在本批授权范围内）。
 */
export const CHANNEL_TONE_CLASS: Record<'local' | 'pickup' | 'express', string> = {
  local: 'bg-orange-50 text-orange-700',
  pickup: 'bg-teal-50 text-teal-700',
  express: 'bg-blue-50 text-blue-700',
}

/**
 * 用户管理订单弹窗里的渠道小标签：文案与 `channelTag` 不同（这里店主要的是「同城/自取/邮寄」，
 * 不是「外送/自取/邮寄」——「同城」与订单列表页的渠道筛选 tab 文案对齐），颜色复用同一张表。
 */
export function userOrderChannel(deliveryType: string): { label: '同城' | '自取' | '邮寄'; cls: string } {
  const { tone } = channelTag(deliveryType)
  const label = tone === 'pickup' ? '自取' : tone === 'express' ? '邮寄' : '同城'
  return { label, cls: CHANNEL_TONE_CLASS[tone] }
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

export type OrderListRow = Pick<Order, 'deliveryType' | 'status' | 'pickupAt' | 'pickupReadyAt' | 'completedAt' | 'shipment' | 'latestDelivery' | 'scheduledAt' | 'schedule'>

/**
 * 宽屏第 7 列（配送·取餐）两行文字：
 *   LOCAL   → ['骑手 X' | '未呼叫', 配送单状态]；预约单（scheduledAt 非空）首行换成「预约 <送达时段>」
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
  const line2 = d ? (DELIVERY_STATUS_LABEL[d.status] ?? d.status) : ''
  // 预约单：列表接口不保证带 schedule 节（只保证 scheduledAt），没有 schedule 就退回时刻格式化
  if (o.scheduledAt) {
    const line1 = `预约 ${o.schedule?.slotLabel ?? fmtMonthDayTime(o.scheduledAt)}`
    return [line1, line2]
  }
  const line1 = d?.courierName ? `骑手 ${d.courierName}` : '未呼叫'
  return [line1, line2]
}
