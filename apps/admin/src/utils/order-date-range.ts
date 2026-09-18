import { todayKey, shiftDayKey } from './time.ts'

export type OrderRangeKey = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom'

export const ORDER_RANGE_PRESETS: { key: OrderRangeKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
  { key: 'custom', label: '自选' },
]

export interface OrderDateState {
  range: OrderRangeKey
  startDate: string
  endDate: string
}

const VALID_RANGE_KEYS = new Set<OrderRangeKey>(ORDER_RANGE_PRESETS.map((p) => p.key))

/** 从 URL 参数还原筛选状态；非法 range 一律退回「全部」 */
export function readOrderDate(params: URLSearchParams): OrderDateState {
  const raw = params.get('range') ?? ''
  const range: OrderRangeKey = VALID_RANGE_KEYS.has(raw as OrderRangeKey) ? (raw as OrderRangeKey) : 'all'
  if (range === 'custom') {
    return { range, startDate: params.get('startDate') ?? '', endDate: params.get('endDate') ?? '' }
  }
  return { range, startDate: '', endDate: '' }
}

/** 把筛选状态写回 URL 参数（就地改，返回同一个 URLSearchParams 便于链式调用） */
export function writeOrderDate(params: URLSearchParams, s: OrderDateState): URLSearchParams {
  if (s.range === 'all') {
    params.delete('range')
    params.delete('startDate')
    params.delete('endDate')
    return params
  }
  params.set('range', s.range)
  if (s.range === 'custom') {
    if (s.startDate) params.set('startDate', s.startDate); else params.delete('startDate')
    if (s.endDate) params.set('endDate', s.endDate); else params.delete('endDate')
  } else {
    params.delete('startDate')
    params.delete('endDate')
  }
  return params
}

/**
 * 筛选状态 → 服务端查询参数；all → {}；custom 只在两端都合法时给；预设的日期算法与
 * `utils/date-range.ts` 的 `QUICK`（今日/昨日/近7天/近30天）同源——都是 `todayKey`/`shiftDayKey`。
 * 这里**不直接调用 `QUICK[...].range()`**：那几个闭包内部用 `new Date()` 取「现在」，
 * 测试没法钉时刻；本函数显式接收并透传 `now`，「北京 00:30 的 today 是明天」这类时区边界
 * 才能被单测钉住，而不是取决于跑测试那一刻的真实时间。
 */
export function orderDateQuery(s: OrderDateState, now: Date): { startDate?: string; endDate?: string } {
  if (s.range === 'all') return {}
  if (s.range === 'custom') {
    if (!s.startDate || !s.endDate || s.endDate < s.startDate) return {}
    return { startDate: s.startDate, endDate: s.endDate }
  }
  if (s.range === 'today') { const k = todayKey(now); return { startDate: k, endDate: k } }
  if (s.range === 'yesterday') { const k = shiftDayKey(-1, now); return { startDate: k, endDate: k } }
  if (s.range === '7d') return { startDate: shiftDayKey(-6, now), endDate: todayKey(now) }
  if (s.range === '30d') return { startDate: shiftDayKey(-29, now), endDate: todayKey(now) }
  return {}
}

/** custom 校验：缺一端 / 止早于起才有错；不设最大跨度（店主要看完整历史，服务端分页兜底） */
export function orderDateError(s: OrderDateState): string | null {
  if (s.range !== 'custom') return null
  if (!s.startDate || !s.endDate) return '请选完整的起止日期'
  if (s.endDate < s.startDate) return '结束日期早于开始日期'
  return null
}

/** `YYYY-MM-DD` → `M月D日`；纯字符串拆分，不经 Date/时区（闸门 check-admin-timezone.mjs 也因此不用管它） */
function monthDayCn(dateKey: string): string {
  const [, m, d] = dateKey.split('-')
  return `${Number(m)}月${Number(d)}日`
}

/** 「共 N 单」前缀用的摘要文案。`now` 当前预设分支不需要（QUICK 的日期已经算好），保留是为了与
 * `orderDateQuery` 同签名、给调用方一致的心智模型，也方便以后要按 `now` 判断的场景不用改调用点。 */
export function orderDateSummary(s: OrderDateState, _now: Date): string {
  if (s.range === 'all') return ''
  if (s.range === 'today') return '今日'
  if (s.range === 'yesterday') return '昨日'
  if (s.range === '7d') return '近7天'
  if (s.range === '30d') return '近30天'
  // custom
  if (orderDateError(s)) return ''
  if (s.startDate === s.endDate) return monthDayCn(s.startDate)
  return `${monthDayCn(s.startDate)} – ${monthDayCn(s.endDate)}`
}
