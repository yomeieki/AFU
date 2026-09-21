/**
 * 预约送达的纯计算（spec 2026-09-21-scheduled-delivery-design §2、§4.1、§6.1）。
 * 四个倒推时刻只在这里算；工作台、定时任务、取消判定、小票全部调 scheduleTimeline，不各自倒推。
 * 不 import prisma、不抛 AppError。
 */
import {
  LocalDeliverySettings, rideMinutes, minutesInPeak, isHolidayOn, isPaused, shanghaiDateStr,
} from '../local-settings'
import { SlotDay, MIN, buildSlotDays, shanghaiMinutesOf, atShanghai, toMin, slotLabel } from '../slots'

export interface ScheduleTimeline {
  scheduledAt: Date
  /** 该呼叫 = 送达 − 路上 − 呼叫到取走 */
  callAt: Date
  /** 开始备餐 = 该呼叫 − 备餐 */
  prepStartAt: Date
  /** 接单截止 = 开始备餐 − 缓冲。催单/重复播报只在它之后 */
  acceptDueAt: Date
  /** 出票 = 开始备餐 − 提前量 */
  ticketAt: Date
  /** 自助取消截止 = 送达 − selfCancelLeadMin */
  selfCancelUntil: Date
  prepMinutes: number
  rideMinutes: number
}

/** 预约单备餐时长：schedule.prepMinutes，送达时刻落在高峰时取与 peak.prepMaxMinutes 的大者（未决歧义 2） */
export function schedulePrepMinutes(s: LocalDeliverySettings, at: Date): number {
  return minutesInPeak(s, shanghaiMinutesOf(at)) ? Math.max(s.schedule.prepMinutes, s.peak.prepMaxMinutes) : s.schedule.prepMinutes
}

export function scheduleTimeline(s: LocalDeliverySettings, scheduledAt: Date, distanceM: number): ScheduleTimeline {
  const ride = rideMinutes(s, distanceM)
  const prep = schedulePrepMinutes(s, scheduledAt)
  const callAt = new Date(scheduledAt.getTime() - (ride + s.callToPickupMin) * MIN)
  const prepStartAt = new Date(callAt.getTime() - prep * MIN)
  const acceptDueAt = new Date(prepStartAt.getTime() - s.schedule.acceptBufferMin * MIN)
  const ticketAt = new Date(prepStartAt.getTime() - s.schedule.prepTicketLeadMin * MIN)
  const selfCancelUntil = new Date(scheduledAt.getTime() - s.selfCancelLeadMin * MIN)
  return { scheduledAt, callAt, prepStartAt, acceptDueAt, ticketAt, selfCancelUntil, prepMinutes: prep, rideMinutes: ride }
}

/** 一格可选要提前多少分钟 = 路上 + 呼叫到取走 + 备餐 + 接单缓冲（= scheduledAt − acceptDueAt） */
export function scheduleLeadMinutes(s: LocalDeliverySettings, slotStart: Date, distanceM: number): number {
  return rideMinutes(s, distanceM) + s.callToPickupMin + schedulePrepMinutes(s, slotStart) + s.schedule.acceptBufferMin
}

export interface DeliverySlotsView {
  days: SlotDay[]
  earliestAt: string | null
  slotMinutes: number
  blocked: null | { kind: 'DISABLED' | 'HOLIDAY' | 'PAUSED'; text: string }
}

/**
 * 外送时段。多两条规则：开始备餐不得早于该营业段开门；暂停期间的格子不出
 * （paused.until 之前不出、之后照出；until 为空视为当天全停，明天照出）。
 */
export function buildDeliverySlots(s: LocalDeliverySettings, distanceM: number, now: Date = new Date()): DeliverySlotsView {
  const slotMinutes = s.schedule.slotMinutes
  if (!s.schedule.enabled) return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'DISABLED', text: '预约配送暂未开通' } }
  const paused = isPaused(s, now)
  const pausedUntil = paused && s.paused?.until && Number.isFinite(Date.parse(s.paused.until)) ? Date.parse(s.paused.until) : null
  const today = shanghaiDateStr(now)
  const r = buildSlotDays({
    businessHours: s.businessHours, slotMinutes, daysAhead: s.schedule.daysAhead, now,
    isHolidayOn: (d) => isHolidayOn(s, d),
    leadMinutesOf: (start) => scheduleLeadMinutes(s, start, distanceM),
    slotFilter: (start, window, date) => {
      if (scheduleTimeline(s, start, distanceM).prepStartAt.getTime() < atShanghai(date, toMin(window.start)).getTime()) return false
      if (!paused) return true
      if (pausedUntil === null) return date !== today
      return start.getTime() >= pausedUntil
    },
  })
  if (r.allHoliday) {
    const until = s.holiday?.until
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'HOLIDAY', text: `休息中${until ? `，${until.slice(5).replace('-', '月')}日后恢复` : ''}` } }
  }
  if (paused && r.earliestAt === null) {
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'PAUSED', text: `同城配送暂停接单${s.paused?.reason ? `：${s.paused.reason}` : ''}` } }
  }
  return { days: r.days, earliestAt: r.earliestAt, slotMinutes, blocked: null }
}

/** 下单时校验：scheduledAt 必须精确命中此刻用同一 distanceM 算出的某一格起点 */
export function isValidDeliverySlot(s: LocalDeliverySettings, scheduledAt: Date, distanceM: number, now: Date = new Date()): boolean {
  const iso = scheduledAt.toISOString()
  return buildDeliverySlots(s, distanceM, now).days.some((d) => d.slots.some((x) => x.startAt === iso))
}

/** 页头没有地址时的保守最早送达文案：按配送半径算最坏路上时间。不可约时返回空串 */
export function earliestScheduleText(s: LocalDeliverySettings, now: Date = new Date()): string {
  const v = buildDeliverySlots(s, Math.round(s.radiusKm * 1000), now)
  if (v.blocked || !v.earliestAt) return ''
  return `最早${slotLabel(new Date(v.earliestAt), v.slotMinutes, now)}送达`
}

/** 现在呼叫预计几点送到 = now + 呼叫到取走 + 路上 */
export function etaIfCallNow(s: LocalDeliverySettings, distanceM: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + (s.callToPickupMin + rideMinutes(s, distanceM)) * MIN)
}

/** 工作台卡片阶段（spec §6.1 六态 + CALLED，计划差异⑥）。LATE 优先：过了约定时刻骑手还没取餐 */
export type SchedulePhase = 'WAITING' | 'TICKETED' | 'PREPPING' | 'CALL_DUE' | 'READY_WAITING' | 'CALLED' | 'LATE'
export function schedulePhase(tl: ScheduleTimeline, o: { readyAt: Date | null; pickedUp: boolean }, now: Date = new Date()): SchedulePhase {
  const t = now.getTime()
  if (!o.pickedUp && t > tl.scheduledAt.getTime()) return 'LATE'
  if (o.readyAt) return t < tl.callAt.getTime() ? 'READY_WAITING' : 'CALLED'
  if (t >= tl.callAt.getTime()) return 'CALL_DUE'
  if (t >= tl.prepStartAt.getTime()) return 'PREPPING'
  if (t >= tl.ticketAt.getTime()) return 'TICKETED'
  return 'WAITING'
}

/** 顾客详情、管理端详情、工作台共用的 schedule 节。非预约单或缺距离 → null */
export function scheduleView(
  s: LocalDeliverySettings,
  order: { deliveryType: string; scheduledAt: Date | null; distanceM: number | null; readyAt: Date | null },
  now: Date = new Date(),
  pickedUp = false,
) {
  if (order.deliveryType !== 'LOCAL' || !order.scheduledAt || order.distanceM === null) return null
  const tl = scheduleTimeline(s, order.scheduledAt, order.distanceM)
  return {
    scheduledAt: tl.scheduledAt.toISOString(),
    slotLabel: slotLabel(tl.scheduledAt, s.schedule.slotMinutes, now),
    ticketAt: tl.ticketAt.toISOString(),
    prepStartAt: tl.prepStartAt.toISOString(),
    callAt: tl.callAt.toISOString(),
    acceptDueAt: tl.acceptDueAt.toISOString(),
    selfCancelUntil: tl.selfCancelUntil.toISOString(),
    readyAt: order.readyAt?.toISOString() ?? null,
    phase: schedulePhase(tl, { readyAt: order.readyAt, pickedUp }, now),
    etaIfCallNow: etaIfCallNow(s, order.distanceM, now).toISOString(),
    callToleranceMin: s.schedule.callToleranceMin,
  }
}
