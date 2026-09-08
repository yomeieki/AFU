/**
 * 邮寄取件预约的状态机：rank 单调推进 + 终态化；快递100「上门取件」回调状态 → 本地状态的映射。
 * 与同城 delivery/state.ts 平行，互不引用。
 * 状态：PENDING(占位，未外呼完成) → BOOKED → ACCEPTED → PICKED → DELIVERED；
 *       分支 CANCELLED / FAILED / UNKNOWN(外呼超时，等对账或回调认领) / VOID(对账确认无单)。
 */
export const BOOKING_RANK: Record<string, number> = { PENDING: 0, UNKNOWN: 5, BOOKED: 10, ACCEPTED: 20, PICKED: 30, DELIVERED: 100 }
export const BOOKING_TERMINAL = ['DELIVERED', 'CANCELLED', 'FAILED', 'VOID'] as const
export const BOOKING_ACTIVE = ['BOOKED', 'ACCEPTED', 'UNKNOWN'] as const

export const BOOKING_STATUS_LABEL: Record<string, string> = {
  PENDING: '预约中', UNKNOWN: '待核对', BOOKED: '已预约·待接单', ACCEPTED: '快递员已接单', PICKED: '已取件',
  DELIVERED: '已签收', CANCELLED: '已取消', FAILED: '预约失败', VOID: '已作废',
}

export interface RankEntry { type: 'rank'; status: 'BOOKED' | 'ACCEPTED' | 'PICKED' | 'DELIVERED'; rank: number; stamp?: 'acceptedAt' | 'pickedAt' | 'deliveredAt' }
export interface SideEntry { type: 'side'; kind: 'CANCELLED' | 'FAILED' | 'FEE' | 'ALERT' | 'IGNORE'; label: string }

/** 快递100 上门取件回调 data.status → 本地动作（docs/research/2026-09-08 §3.2） */
export const KD_EXPRESS_STATUS_MAP: Record<string, RankEntry | SideEntry> = {
  '0': { type: 'rank', status: 'BOOKED', rank: 10 },
  '1': { type: 'rank', status: 'ACCEPTED', rank: 20, stamp: 'acceptedAt' },
  '2': { type: 'rank', status: 'ACCEPTED', rank: 20, stamp: 'acceptedAt' },
  '10': { type: 'rank', status: 'PICKED', rank: 30, stamp: 'pickedAt' },
  '13': { type: 'rank', status: 'DELIVERED', rank: 100, stamp: 'deliveredAt' },
  '11': { type: 'side', kind: 'FAILED', label: '揽货失败' },
  '610': { type: 'side', kind: 'FAILED', label: '下单失败' },
  '9': { type: 'side', kind: 'CANCELLED', label: '用户取消' },
  '99': { type: 'side', kind: 'CANCELLED', label: '订单取消' },
  '15': { type: 'side', kind: 'FEE', label: '已结算' },
  '155': { type: 'side', kind: 'FEE', label: '修改重量' },
  '101': { type: 'side', kind: 'IGNORE', label: '运输中' },
  '400': { type: 'side', kind: 'IGNORE', label: '派送中' },
  '200': { type: 'side', kind: 'IGNORE', label: '已出单' },
  '201': { type: 'side', kind: 'IGNORE', label: '出单失败' },
  '12': { type: 'side', kind: 'ALERT', label: '已退回' },
  '14': { type: 'side', kind: 'ALERT', label: '异常签收' },
  '166': { type: 'side', kind: 'ALERT', label: '订单复活' },
}

/** 白名单：终态不可再动；rank 只能前进；取件后不能被取消/失败；UNKNOWN 可认领为 BOOKED 或作废 */
export function canTransition(from: string, to: string): boolean {
  if ((BOOKING_TERMINAL as readonly string[]).includes(from)) return false
  if (to === 'VOID') return from === 'UNKNOWN'
  if (to === 'CANCELLED' || to === 'FAILED') return from === 'PENDING' || from === 'UNKNOWN' || from === 'BOOKED' || from === 'ACCEPTED'
  if (to === 'UNKNOWN') return from === 'PENDING'
  const a = BOOKING_RANK[from], b = BOOKING_RANK[to]
  if (a === undefined || b === undefined) return false
  return b > a
}
