import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { REAL_ORDERS } from '../../../utils/stats-scope'
import type { LocalDayParts } from '../../../utils/local-day'

/**
 * 经营概览三接口共用的区间解析与订单口径。
 * 口径：docs/superpowers/specs/2026-09-08-dashboard-redesign-design.md §3。
 */
export interface Range {
  start: Date
  endExclusive: Date
  startDate: string
  endDate: string
  days: number
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 92

const rangeSchema = z.object({
  startDate: z.string().regex(DAY, '日期格式须为 YYYY-MM-DD').optional(),
  endDate: z.string().regex(DAY, '日期格式须为 YYYY-MM-DD').optional(),
})

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * [start 00:00, end 次日 00:00)，默认近 7 天（含今日）；同时给出紧挨在前、等长的「上期」。
 * `new Date('YYYY-MM-DDT00:00:00')` 按服务端本地时区解释——服务端固定 Asia/Shanghai，
 * 与 routes/admin/scan-stats.ts 的 parseRange 同一做法。
 */
export function parseRange(query: unknown): { cur: Range; prev: Range } {
  const q = rangeSchema.parse(query)
  const end = q.endDate ? new Date(`${q.endDate}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0))
  const endExclusive = new Date(end)
  endExclusive.setDate(endExclusive.getDate() + 1)
  const start = q.startDate ? new Date(`${q.startDate}T00:00:00`) : new Date(end)
  if (!q.startDate) start.setDate(start.getDate() - 6)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new z.ZodError([{ code: 'custom', path: ['startDate'], message: '日期无效', input: q }])
  }
  const days = Math.round((endExclusive.getTime() - start.getTime()) / 86400000)
  if (days < 1 || days > MAX_DAYS) {
    throw new z.ZodError([{ code: 'custom', path: ['endDate'], message: `区间须为 1–${MAX_DAYS} 天`, input: q }])
  }
  const prevStart = new Date(start)
  prevStart.setDate(prevStart.getDate() - days)
  const prevEndDay = new Date(start)
  prevEndDay.setDate(prevEndDay.getDate() - 1)
  return {
    cur: { start, endExclusive, startDate: dayKey(start), endDate: dayKey(end), days },
    // 上期的 endExclusive 单独 new 一份：与 cur.start 共用同一个 Date 对象的话，哪天有人对它 setDate 就把本期也挪了
    prev: { start: prevStart, endExclusive: new Date(start), startDate: dayKey(prevStart), endDate: dayKey(prevEndDay), days },
  }
}

export const rangeOut = (cur: Range, prev: Range) => ({
  startDate: cur.startDate,
  endDate: cur.endDate,
  prevStartDate: prev.startDate,
  prevEndDate: prev.endDate,
})

/** 参与统计的订单：真实单 + 付款时间落在区间内；状态不限（退款单也算单数，退款额另计） */
export function paidOrdersWhere(r: Range, channel?: 'LOCAL' | 'EXPRESS'): Prisma.OrderWhereInput {
  return {
    ...REAL_ORDERS,
    paidAt: { gte: r.start, lt: r.endExclusive },
    ...(channel ? { deliveryType: channel } : {}),
  }
}

/** 名次向上取整的分位数；空数组 null。结果四舍五入到整数（调用方传的是分钟/小时）。 */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return Math.round(sorted[idx])
}
export const median = (v: number[]) => percentile(v, 0.5)

/** 把 localDayPartsSql 取出的 UTC 年月日时还原成上海小时（0–23）。与 localDayKeyFromParts 同一思路。 */
export function localHourFromParts(r: LocalDayParts): number {
  return new Date(Date.UTC(Number(r.y), Number(r.mo) - 1, Number(r.d), Number(r.h))).getHours()
}

export const minutesBetween = (a: Date | null | undefined, b: Date | null | undefined): number | null =>
  a && b ? (b.getTime() - a.getTime()) / 60000 : null
