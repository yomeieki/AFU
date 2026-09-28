/**
 * 自取单在工作台上的时间语义（spec 2026-09-11 §6.1、P9）。全部是纯函数，便于单测；
 * 日期比较走 utils/time 的 todayKey（Asia/Shanghai），不碰本地时区 API（见 scripts/check-admin-timezone.mjs）。
 */
import { todayKey, fmtDateTime, fmtHHmm } from './time.ts'

export type PickupUrgency = '' | 'warn' | 'late'
export type PickupColKey = 'pending' | 'preparing' | 'waitingCourier' | 'delivering' | 'done'

/** 备餐中：距取餐 ≤15 分琥珀、≤5 分（含已过点）红——与同城「预计送达」同一把尺子 */
const PICKUP_WARN_MIN = 15
const PICKUP_LATE_MIN = 5
/** 待接单计时提前量：与服务端 remindPickupUnaccepted 的「开始备餐 −15 分」同口径 */
const PENDING_LEAD_MIN = 15

/** 「距取餐 N 分」/「已过取餐时间 N 分钟」（文案见 spec §6.1） */
export function pickupCountdown(pickupAt: string, now: number): { text: string; overdueMin: number } {
  const left = (Date.parse(pickupAt) - now) / 60_000
  if (left > 0) return { text: `距取餐 ${Math.ceil(left)} 分`, overdueMin: 0 }
  // Math.floor(-left) 在 left 恰为 0 时会产出 -0（deepStrictEqual 视 -0 ≠ 0），用 Math.max 规整成 +0
  const over = Math.max(0, Math.floor(-left))
  return { text: `已过取餐时间 ${over} 分钟`, overdueMin: over }
}

/**
 * 取餐日不是今天（上海日历日）→ 收进「明日自取」折叠组。
 * 尽快单（asap，2026-09-28）永远不算：23:50 付款、次日 00:04 可取的单是「现在就要做」的单。
 */
export function isFutureDayPickup(pickupAt: string | null | undefined, now: number, asap = false): boolean {
  if (!pickupAt || asap) return false
  return todayKey(new Date(pickupAt)) !== todayKey(new Date(now))
}

export function pickupUrgency(
  colKey: PickupColKey,
  p: { pickupAt: string | null; prepStartAt: string | null; asap?: boolean },
  now: number,
): PickupUrgency {
  if (!p.pickupAt || colKey === 'done' || colKey === 'pending' || colKey === 'waitingCourier') return ''
  if (isFutureDayPickup(p.pickupAt, now, p.asap)) return ''
  const left = (Date.parse(p.pickupAt) - now) / 60_000
  if (colKey === 'preparing') {
    if (left <= PICKUP_LATE_MIN) return 'late'
    if (left <= PICKUP_WARN_MIN) return 'warn'
    return ''
  }
  // delivering = 待取餐：过了取餐时间转琥珀（spec：过时未取卡片橙色），不升红——红留给退菜/异常
  return left <= 0 ? 'warn' : ''
}

/**
 * 待接单的等待锚点：明天/下午的单不该从付款那一刻就开始「烧」，从开始备餐前 15 分钟起算。
 * 尽快单（asap）一律从付款时刻起算——它付款即出票、现在就要做（与同城立即单同一把尺子）。
 */
export function pickupPendingAnchor(waitSince: string, prepStartAt: string | null, asap = false): number {
  const paid = Date.parse(waitSince)
  if (!prepStartAt || asap) return paid
  const lead = Date.parse(prepStartAt) - PENDING_LEAD_MIN * 60_000
  return Number.isFinite(lead) ? Math.max(paid, lead) : paid
}

/**
 * 后台订单详情「取餐信息」卡的取餐时间那一行（2026-09-28 尽快取）：
 * 尽快单「尽快取 · 预计 HH:mm」（pickupAt 是付款时重算后的预计可取时刻）；预约单「预约取餐 <日期时间>」照旧。
 * 没有 pickupAt 返回 ''（不渲染这一行）。
 */
export function pickupDetailLine(o: { pickupAt?: string | null; pickupAsap?: boolean }): string {
  if (!o.pickupAt) return ''
  return o.pickupAsap ? `尽快取 · 预计 ${fmtHHmm(o.pickupAt)}` : `预约取餐 ${fmtDateTime(o.pickupAt)}`
}
