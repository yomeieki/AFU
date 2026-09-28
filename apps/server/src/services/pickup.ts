/**
 * 到店自取的纯计算（spec 2026-09-11-local-pickup-design §4.2、§4.3）。
 * 2026-09-21 起切格/文案下沉到 services/slots.ts（与预约外送共用），本文件只剩自取自己的：
 * 备餐时长按取餐时刻判高峰、开始备餐时刻、DISABLED/PAUSED/HOLIDAY 三种阻塞、自取优惠。
 * 不 import prisma、不抛 AppError；每条边界由 scripts/selftest-pickup.ts 穷举。
 */
import { LocalDeliverySettings, isHolidayOn, isHolidayNow, isPickupPaused, minutesInPeak, shanghaiDateStr } from './local-settings'
import { Slot, SlotDay, MIN, atShanghai, buildSlotDays, hhmmOf, shanghaiMinutesOf, slotLabel, ticketLabel, ticketLabelParts, toMin } from './slots'

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

/**
 * 最早可取时段相对当前营业段的判据（2026-09-23 修订 1，复核 R2）：小程序据此区分「现在就在营业，
 * 约的是本段稍后」「现在营业段已约不到，约的是下一段/明天」「一格都约不了」三种措辞。
 * - NONE：`buildPickupSlots` 被 blocked，或 daysAhead 内一格都没有。
 * - CURRENT：此刻落在某个营业段内，且最早格落在**同一天、同一段**里（段内挪到稍后）。
 * - LATER：其余（含营业时间外，以及此刻虽在营业段内但本段已约不到、最早是下一段或明天——
 *   即"尾段"）。
 * 只调一次 buildPickupSlots，选择器（时段列表）与提示文案同源，不会互相打架。
 */
export type PickupEarliestWhen = 'CURRENT' | 'LATER' | 'NONE'
export function earliestPickupInfo(s: LocalDeliverySettings, now: Date = new Date()): { text: string; when: PickupEarliestWhen } {
  const v = buildPickupSlots(s, now)
  if (v.blocked || !v.earliestAt) return { text: '', when: 'NONE' }
  const text = `最早${slotLabel(new Date(v.earliestAt), v.slotMinutes, now)} 可取`
  const earliestAt = new Date(v.earliestAt)
  const cur = shanghaiMinutesOf(now)
  const currentWindow = s.businessHours.find((h) => toMin(h.start) <= cur && cur < toMin(h.end))
  const sameDay = shanghaiDateStr(earliestAt) === shanghaiDateStr(now)
  const when: PickupEarliestWhen =
    currentWindow && sameDay && shanghaiMinutesOf(earliestAt) < toMin(currentWindow.end) ? 'CURRENT' : 'LATER'
  return { text, when }
}

/** 页头没有下单时刻只有「此刻」的保守最早可取文案：与 earliestScheduleText 同构。不可约时返回空串 */
export function earliestPickupText(s: LocalDeliverySettings, now: Date = new Date()): string {
  return earliestPickupInfo(s, now).text
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

// ── 尽快取（2026-09-28，plans/2026-09-28-pickup-asap.md「关键决定」）───────────────────
// 服务端唯一实现：结算页（pickup-slots / meta）、下单、两条付款路径（mock 与真实回调）都只调这里，
// 不各写一份公式。全部纯函数：时刻与设置都由调用方传入。

export type PickupAsapReason = 'DISABLED' | 'PAUSED' | 'HOLIDAY' | 'CLOSED' | 'NONE' | 'TOO_LATE'
export interface PickupAsapInfo {
  available: boolean
  /** 预计可取时刻（ISO）。不可用时为 null */
  readyAt: string | null
  /** 备餐 + 接单缓冲（分钟）。不可用时为 null */
  minutes: number | null
  reason: null | PickupAsapReason
}

/**
 * 尽快单的预计可取时刻（只管公式，不判可用性）：P = 备餐，B = 接单缓冲。
 * 先按平时备餐算临时取餐时刻 t+P+B，它落在高峰窗口就把 P 换成高峰上限；
 * readyAt = 向上取整到整分(t + P + B)，minutes = P + B。
 */
export function asapReadyAt(s: LocalDeliverySettings, t: Date): { readyAt: Date; minutes: number } {
  const buffer = s.pickup.acceptBufferMin
  const tentative = new Date(t.getTime() + (s.prepMinutes + buffer) * MIN)
  const prep = minutesInPeak(s, shanghaiMinutesOf(tentative)) ? s.peak.prepMaxMinutes : s.prepMinutes
  const raw = t.getTime() + (prep + buffer) * MIN
  // 上海是整小时时区，按纪元毫秒向上取整到整分与按上海钟点取整等价
  return { readyAt: new Date(Math.ceil(raw / MIN) * MIN), minutes: prep + buffer }
}

/**
 * 此刻能不能「尽快取」。按下面顺序判，第一个不满足的就是 reason：
 * 未开通 DISABLED → 今天休业 HOLIDAY → 自取暂停 PAUSED → 此刻不在任何营业段 CLOSED →
 * daysAhead 内一格都约不到 NONE（「今日已约满」）→ 预计可取时刻不严格早于本段结束 TOO_LATE。
 * **外送暂停/外送开关不影响尽快取**（自取有自己的暂停开关）。
 */
export function pickupAsapInfo(s: LocalDeliverySettings, now: Date = new Date()): PickupAsapInfo {
  const no = (reason: PickupAsapReason): PickupAsapInfo => ({ available: false, readyAt: null, minutes: null, reason })
  if (!s.pickup.enabled) return no('DISABLED')
  if (isHolidayNow(s, now)) return no('HOLIDAY')
  if (isPickupPaused(s, now)) return no('PAUSED')
  const cur = shanghaiMinutesOf(now)
  const window = s.businessHours.find((h) => toMin(h.start) <= cur && cur < toMin(h.end))
  if (!window) return no('CLOSED')
  if (earliestPickupInfo(s, now).when === 'NONE') return no('NONE')
  const { readyAt, minutes } = asapReadyAt(s, now)
  const windowEnd = atShanghai(shanghaiDateStr(now), toMin(window.end))
  if (readyAt.getTime() >= windowEnd.getTime()) return no('TOO_LATE')
  return { available: true, readyAt: readyAt.toISOString(), minutes, reason: null }
}

/** 下单时尽快取不可用（42285）的顾客文案，按 reason 区分。DISABLED/PAUSED/HOLIDAY 由 42280 先报，这里只兜底 */
export function pickupAsapUnavailableText(reason: PickupAsapReason | null): string {
  if (reason === 'CLOSED') return '现在不在营业时间，暂不能尽快取，请预约取餐时间'
  if (reason === 'TOO_LATE') return '本段营业快结束了，来不及备餐，请预约取餐时间'
  if (reason === 'NONE') return '暂无可取时段，暂不能尽快取'
  return '暂不能尽快取，请预约取餐时间'
}

/**
 * 付款成功时重算尽快单的预计可取时刻（店主 2026-09-28 选 Q2=B，锚点取较晚者）。
 * - 非尽快单（预约自取、同城、邮寄）或 pickupAt 为空：返回 null，调用方**不写** pickupAt。
 * - 尽快单：锚点 = max(paidAt, processedAt)，在**这里**取；返回 max(原 pickupAt, asapReadyAt(实时设置, 锚点))，
 *   永不往前挪。真实回调传 success_time（缺省服务器时刻）与处理本次回调时的服务器时钟；mock 两个都传服务器当前时刻。
 * 付款时**不校验**尽快可用性（Q3=A 照收照做）：结果可以落在本段营业结束之后，不封顶。
 * paidAt 本身的取值与含义不变——锚点只用来算 pickupAt，不回写任何 paidAt 列。
 */
export function asapPickupAtOnPaid(
  order: { deliveryType: string; pickupAsap: boolean; pickupAt: Date | null },
  s: LocalDeliverySettings,
  paidAt: Date,
  processedAt: Date,
): Date | null {
  if (order.deliveryType !== 'PICKUP' || !order.pickupAsap || !order.pickupAt) return null
  const anchor = paidAt.getTime() >= processedAt.getTime() ? paidAt : processedAt
  const { readyAt } = asapReadyAt(s, anchor)
  return readyAt.getTime() > order.pickupAt.getTime() ? readyAt : order.pickupAt
}

/** 尽快单的取餐文案「尽快取 约 HH:mm」（上海钟点）。票面放大行也是这一串（15 列，≤16） */
export function asapPickupLabel(pickupAt: Date): string {
  return `尽快取 约 ${hhmmOf(pickupAt)}`
}

/**
 * 取餐文案：工作台、企微来单推送、未取提醒、自动完成共用这一个。
 * 尽快单「尽快取 约 HH:mm」；预约单原样返回 slotLabel（与改动前逐字节一致）。
 */
export function pickupTimeLabel(o: { pickupAt: Date; pickupAsap?: boolean | null }, s: LocalDeliverySettings, now: Date = new Date()): string {
  return o.pickupAsap ? asapPickupLabel(o.pickupAt) : slotLabel(o.pickupAt, s.pickup.slotMinutes, now)
}

/**
 * 小票取餐联的五个字段（services/ticket/index.ts 的 toTicketInput 展开它；抽成纯函数是为了不连库也能自测）。
 * - 预约单：与改前 toTicketInput 里的四行逐字节一致（绝对日期 + 放大时段 + 非今天盖戳）。
 * - 尽快单：只给「尽快取 约 HH:mm」一条放大行，日期行、时段行、戳一律 null——跨零点（23:50 下单、
 *   次日 00:04 可取）也不盖「明日单」，那是现在就要做的单。
 */
export function pickupTicketFields(pickupAt: Date | null, pickupAsap: boolean, slotMinutes: number, now: Date = new Date()): {
  pickupAsap: boolean; pickupSlotLabel: string | null; pickupSlotDate: string | null; pickupSlotTime: string | null; pickupDayStamp: string | null
} {
  if (!pickupAt) return { pickupAsap, pickupSlotLabel: null, pickupSlotDate: null, pickupSlotTime: null, pickupDayStamp: null }
  if (pickupAsap) return { pickupAsap, pickupSlotLabel: asapPickupLabel(pickupAt), pickupSlotDate: null, pickupSlotTime: null, pickupDayStamp: null }
  return {
    pickupAsap,
    pickupSlotLabel: ticketLabel(pickupAt, slotMinutes, now).text,
    pickupSlotDate: ticketLabelParts(pickupAt, slotMinutes, now).date,
    pickupSlotTime: ticketLabelParts(pickupAt, slotMinutes, now).time,
    pickupDayStamp: ticketLabel(pickupAt, slotMinutes, now).stamp,
  }
}
