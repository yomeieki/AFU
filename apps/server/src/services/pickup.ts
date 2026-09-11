/**
 * 到店自取的纯计算（spec 2026-09-11-local-pickup-design §4.2、§4.3）。
 * 不 import prisma、不抛 AppError：时段/备餐起点/优惠的每条边界都由 scripts/selftest-pickup.ts 穷举，
 * 拒不拒单是路由层的事。全部时刻按 Asia/Shanghai；上海无夏令时，`+08:00` 字面量可直接拼 Date。
 */
import {
  LocalDeliverySettings, shanghaiDateStr, isHolidayOn, isPickupPaused, minutesInPeak,
} from './local-settings'

export interface PickupSlot { startAt: string; endAt: string; label: string }
export interface PickupDay { date: string; label: string; slots: PickupSlot[] }
export interface PickupSlotsView {
  days: PickupDay[]
  earliestAt: string | null
  slotMinutes: number
  blocked: null | { kind: 'HOLIDAY' | 'PAUSED' | 'DISABLED'; text: string }
}

const MIN = 60 * 1000
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const pad2 = (n: number) => String(n).padStart(2, '0')
const hhmm = (minutes: number) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`
/** 上海日期 + 一天内分钟数 → Date */
const atShanghai = (dateStr: string, minutes: number) => new Date(`${dateStr}T${hhmm(minutes)}:00+08:00`)
/** Date → 上海「一天内的分钟数」 */
function shanghaiMinutesOf(d: Date): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0)
  return h * 60 + m
}
function addDays(dateStr: string, n: number): string {
  return shanghaiDateStr(new Date(new Date(`${dateStr}T12:00:00+08:00`).getTime() + n * 24 * 60 * MIN))
}

/** 备餐时长按**取餐时刻**是否在高峰取值（平时 prepMinutes，高峰取上界 prepMaxMinutes） */
export function pickupPrepMinutes(s: LocalDeliverySettings, at: Date): number {
  return minutesInPeak(s, shanghaiMinutesOf(at)) ? s.peak.prepMaxMinutes : s.prepMinutes
}

/** 开始备餐时刻 = 取餐 − 备餐 − 接单缓冲。取消窗口、催单、工作台倒计时都用它。
 *  用**实时**设置而不是下单时快照（spec §2 有意）：店主调备餐时长会连带移动已付款单的
 *  自助退窗口与催单时刻。与 `pickupDiscountAmount` 快照的处理不对称是知情选择。 */
export function prepStartAt(s: LocalDeliverySettings, pickupAt: Date): Date {
  return new Date(pickupAt.getTime() - (pickupPrepMinutes(s, pickupAt) + s.pickup.acceptBufferMin) * MIN)
}

function dayLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return '今天'
  if (dateStr === addDays(todayStr, 1)) return '明天'
  return dateStr.slice(5) // '09-13'
}

function slotsOfDay(s: LocalDeliverySettings, dateStr: string, now: Date): PickupSlot[] {
  const out: PickupSlot[] = []
  const step = s.pickup.slotMinutes
  const sorted = [...s.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  for (const h of sorted) {
    for (let m = toMin(h.start); m + step <= toMin(h.end); m += step) {
      const startAt = atShanghai(dateStr, m)
      // 一格可选：起点 − 备餐(按起点判高峰) − 缓冲 ≥ now。不可选的格子直接不返回
      if (prepStartAt(s, startAt).getTime() < now.getTime()) continue
      out.push({ startAt: startAt.toISOString(), endAt: atShanghai(dateStr, m + step).toISOString(), label: `${hhmm(m)}–${hhmm(m + step)}` })
    }
  }
  return out
}

export function buildPickupSlots(s: LocalDeliverySettings, now: Date = new Date()): PickupSlotsView {
  const slotMinutes = s.pickup.slotMinutes
  const today = shanghaiDateStr(now)
  if (!s.pickup.enabled) return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'DISABLED', text: '到店自取暂未开通' } }
  if (isPickupPaused(s, now)) {
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'PAUSED', text: `自取暂停接单${s.pickup.paused?.reason ? `：${s.pickup.paused.reason}` : ''}` } }
  }
  const days: PickupDay[] = []
  for (let i = 0; i <= s.pickup.daysAhead; i++) {
    const date = addDays(today, i)
    if (isHolidayOn(s, date)) continue
    days.push({ date, label: dayLabel(date, today), slots: slotsOfDay(s, date, now) })
  }
  if (days.length === 0) {
    const until = s.holiday?.until
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'HOLIDAY', text: `休息中${until ? `，${until.slice(5).replace('-', '月')}日后恢复` : ''}` } }
  }
  const earliest = days.flatMap((d) => d.slots)[0] ?? null
  return { days, earliestAt: earliest?.startAt ?? null, slotMinutes, blocked: null }
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

/** 「今天 12:00–12:30」这种给顾客/店员看的文案；小票、通知、工作台共用 */
export function pickupSlotLabel(pickupAt: Date, slotMinutes: number, now: Date = new Date()): string {
  const date = shanghaiDateStr(pickupAt)
  const m = shanghaiMinutesOf(pickupAt)
  return `${dayLabel(date, shanghaiDateStr(now))} ${hhmm(m)}–${hhmm(m + slotMinutes)}`
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** 'YYYY-MM-DD' → '9月12日（周六）'（按上海日历日取星期：正午 +08:00 的 UTC 日期与上海同日） */
function cnDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00+08:00`)
  return `${Number(dateStr.slice(5, 7))}月${Number(dateStr.slice(8, 10))}日（${WEEKDAY[d.getUTCDay()]}）`
}

/**
 * 小票专用取餐文案（PO 2026-09-11 方案一）：纸票是付款那一刻打的，印「明天」到了第二天就成了假话，
 * 所以票面一律印绝对日期 + 星期；相对关系只放在票头的戳里（今天不盖戳，明天「明日单」，更远印日期）。
 * 工作台/通知仍用 pickupSlotLabel——它们每次刷新都按当时重算，不会过期。
 */
export function pickupTicketLabel(pickupAt: Date, slotMinutes: number, now: Date = new Date()): { text: string; stamp: string } {
  const date = shanghaiDateStr(pickupAt)
  const today = shanghaiDateStr(now)
  const m = shanghaiMinutesOf(pickupAt)
  const stamp = date === today ? '' : date === addDays(today, 1) ? '明日单' : `${cnDate(date).replace(/（.*）/, '')}单`
  return { text: `${cnDate(date)}${hhmm(m)}–${hhmm(m + slotMinutes)}`, stamp }
}
