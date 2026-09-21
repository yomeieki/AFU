/**
 * 时段切格公共模块（spec 2026-09-21-scheduled-delivery-design §4.1）。自取与预约外送共用：
 * 切格、可选判定、天数/休业过滤、文案。全部纯函数，不 import prisma、不抛 AppError。
 * 「一格可选要提前多少分钟」由调用方以 leadMinutesOf 传入：自取 = 备餐 + 接单缓冲；
 * 外送 = 路上 + 呼叫到取走 + 备餐 + 接单缓冲。全部时刻按 Asia/Shanghai；上海无夏令时，`+08:00` 字面量可直接拼 Date。
 */
import { BusinessHour, shanghaiDateStr } from './local-settings'

export interface Slot { startAt: string; endAt: string; label: string }
export interface SlotDay { date: string; label: string; slots: Slot[] }

export const MIN = 60 * 1000
export const toMin = (hhmmStr: string) => Number(hhmmStr.slice(0, 2)) * 60 + Number(hhmmStr.slice(3, 5))
const pad2 = (n: number) => String(n).padStart(2, '0')
export const hhmm = (minutes: number) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`
/** 上海日期 + 一天内分钟数 → Date */
export const atShanghai = (dateStr: string, minutes: number) => new Date(`${dateStr}T${hhmm(minutes)}:00+08:00`)
/** Date → 上海「一天内的分钟数」 */
export function shanghaiMinutesOf(d: Date): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0)
  return h * 60 + m
}
/** Date → 'HH:mm'（上海） */
export const hhmmOf = (d: Date) => hhmm(shanghaiMinutesOf(d))
export function addDays(dateStr: string, n: number): string {
  return shanghaiDateStr(new Date(new Date(`${dateStr}T12:00:00+08:00`).getTime() + n * 24 * 60 * MIN))
}
export function dayLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return '今天'
  if (dateStr === addDays(todayStr, 1)) return '明天'
  return dateStr.slice(5) // '09-13'
}

export interface BuildSlotDaysInput {
  businessHours: BusinessHour[]
  slotMinutes: number
  daysAhead: number
  now: Date
  isHolidayOn: (dateStr: string) => boolean
  /** 这一格要提前多少分钟才来得及；`slotStart − lead < now` 的格子不返回 */
  leadMinutesOf: (slotStart: Date) => number
  /** 额外过滤（外送用：开始备餐不早于该营业段开门、暂停期间不出格）。返回 false 的格子不返回 */
  slotFilter?: (slotStart: Date, window: BusinessHour, dateStr: string) => boolean
}

/** 逐天切格。今天一格都没有时 days[0].slots 为空数组照样返回；休业日整天不出现；全部休业 → allHoliday */
export function buildSlotDays(i: BuildSlotDaysInput): { days: SlotDay[]; earliestAt: string | null; allHoliday: boolean } {
  const today = shanghaiDateStr(i.now)
  const step = i.slotMinutes
  const sorted = [...i.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  const days: SlotDay[] = []
  for (let n = 0; n <= i.daysAhead; n++) {
    const date = addDays(today, n)
    if (i.isHolidayOn(date)) continue
    const slots: Slot[] = []
    for (const h of sorted) {
      for (let m = toMin(h.start); m + step <= toMin(h.end); m += step) {
        const startAt = atShanghai(date, m)
        if (startAt.getTime() - i.leadMinutesOf(startAt) * MIN < i.now.getTime()) continue
        if (i.slotFilter && !i.slotFilter(startAt, h, date)) continue
        slots.push({ startAt: startAt.toISOString(), endAt: atShanghai(date, m + step).toISOString(), label: `${hhmm(m)}–${hhmm(m + step)}` })
      }
    }
    days.push({ date, label: dayLabel(date, today), slots })
  }
  const earliest = days.flatMap((d) => d.slots)[0] ?? null
  return { days, earliestAt: earliest?.startAt ?? null, allHoliday: days.length === 0 }
}

/** 「今天 12:00–12:30」这种给顾客/店员看的文案；工作台、通知共用（每次刷新按当时重算，不会过期） */
export function slotLabel(at: Date, slotMinutes: number, now: Date = new Date()): string {
  const m = shanghaiMinutesOf(at)
  return `${dayLabel(shanghaiDateStr(at), shanghaiDateStr(now))} ${hhmm(m)}–${hhmm(m + slotMinutes)}`
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** 'YYYY-MM-DD' → '9月12日（周六）'（按上海日历日取星期：正午 +08:00 的 UTC 日期与上海同日） */
export function cnDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00+08:00`)
  return `${Number(dateStr.slice(5, 7))}月${Number(dateStr.slice(8, 10))}日（${WEEKDAY[d.getUTCDay()]}）`
}

/**
 * 小票专用文案：纸票是付款那一刻打的，印「明天」到了第二天就成了假话，所以票面一律印绝对日期 + 星期；
 * 相对关系只放在票头的戳里（今天不盖戳，明天「明日单」，更远印日期）。
 */
export function ticketLabel(at: Date, slotMinutes: number, now: Date = new Date()): { text: string; stamp: string } {
  const date = shanghaiDateStr(at)
  const today = shanghaiDateStr(now)
  const m = shanghaiMinutesOf(at)
  const stamp = date === today ? '' : date === addDays(today, 1) ? '明日单' : `${cnDate(date).replace(/（.*）/, '')}单`
  return { text: `${cnDate(date)}${hhmm(m)}–${hhmm(m + slotMinutes)}`, stamp }
}
