/**
 * 到店自取的纯计算（spec 2026-09-11-local-pickup-design §4.2、§4.3）。
 * 2026-09-21 起切格/文案下沉到 services/slots.ts（与预约外送共用），本文件只剩自取自己的：
 * 备餐时长按取餐时刻判高峰、开始备餐时刻、DISABLED/PAUSED/HOLIDAY 三种阻塞、自取优惠。
 * 不 import prisma、不抛 AppError；每条边界由 scripts/selftest-pickup.ts 穷举。
 */
import { LocalDeliverySettings, isHolidayOn, isPickupPaused, minutesInPeak } from './local-settings'
import { Slot, SlotDay, MIN, buildSlotDays, shanghaiMinutesOf, slotLabel, ticketLabel } from './slots'

export type PickupSlot = Slot
export type PickupDay = SlotDay
export interface PickupSlotsView {
  days: PickupDay[]
  earliestAt: string | null
  slotMinutes: number
  blocked: null | { kind: 'HOLIDAY' | 'PAUSED' | 'DISABLED'; text: string }
}

/** 备餐时长按**取餐时刻**是否在高峰取值（平时 prepMinutes，高峰取上界 prepMaxMinutes） */
export function pickupPrepMinutes(s: LocalDeliverySettings, at: Date): number {
  return minutesInPeak(s, shanghaiMinutesOf(at)) ? s.peak.prepMaxMinutes : s.prepMinutes
}

/** 开始备餐时刻 = 取餐 − 备餐 − 接单缓冲。催单、工作台倒计时用它。用**实时**设置不用下单时快照（spec §2 有意） */
export function prepStartAt(s: LocalDeliverySettings, pickupAt: Date): Date {
  return new Date(pickupAt.getTime() - (pickupPrepMinutes(s, pickupAt) + s.pickup.acceptBufferMin) * MIN)
}

export function buildPickupSlots(s: LocalDeliverySettings, now: Date = new Date()): PickupSlotsView {
  const slotMinutes = s.pickup.slotMinutes
  if (!s.pickup.enabled) return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'DISABLED', text: '到店自取暂未开通' } }
  if (isPickupPaused(s, now)) {
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'PAUSED', text: `自取暂停接单${s.pickup.paused?.reason ? `：${s.pickup.paused.reason}` : ''}` } }
  }
  const r = buildSlotDays({
    businessHours: s.businessHours, slotMinutes, daysAhead: s.pickup.daysAhead, now,
    isHolidayOn: (d) => isHolidayOn(s, d),
    // 一格可选：起点 − 备餐(按起点判高峰) − 缓冲 ≥ now，与 prepStartAt 同一公式
    leadMinutesOf: (start) => pickupPrepMinutes(s, start) + s.pickup.acceptBufferMin,
  })
  if (r.allHoliday) {
    const until = s.holiday?.until
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'HOLIDAY', text: `休息中${until ? `，${until.slice(5).replace('-', '月')}日后恢复` : ''}` } }
  }
  return { days: r.days, earliestAt: r.earliestAt, slotMinutes, blocked: null }
}

/** 下单时校验：pickupAt 必须精确命中此刻算出的某一格起点 */
export function isValidPickupSlot(s: LocalDeliverySettings, pickupAt: Date, now: Date = new Date()): boolean {
  const iso = pickupAt.toISOString()
  return buildPickupSlots(s, now).days.some((d) => d.slots.some((x) => x.startAt === iso))
}

/** 自取优惠（分）。PERCENT: 小计 − round(小计 × value/100)；FIXED: min(value, 小计) */
export function pickupDiscountOf(s: LocalDeliverySettings, subtotalFen: number): number {
  const d = s.pickup.discount
  if (d.type === 'PERCENT') return Math.max(0, subtotalFen - Math.round((subtotalFen * d.value) / 100))
  if (d.type === 'FIXED') return Math.min(d.value, subtotalFen)
  return 0
}

export const pickupSlotLabel = slotLabel
export const pickupTicketLabel = ticketLabel
