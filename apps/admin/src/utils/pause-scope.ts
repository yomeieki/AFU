/**
 * 「暂停接单」四选一（spec 2026-09-11 §6.1，P12）。工作台弹窗与同城设置页的对话框共用这里的
 * 文案、校验与状态行；真正调接口的顺序在 api/admin.ts（pauseLocal / pausePickup / setHoliday）。
 */
export type PauseScope = 'DELIVERY' | 'PICKUP' | 'ALL_TODAY' | 'HOLIDAY'

export const PAUSE_SCOPES: { key: PauseScope; label: string; hint: string }[] = [
  { key: 'DELIVERY', label: '只暂停外送', hint: '顾客仍可下自取单；到恢复前外送入口显示暂停原因' },
  { key: 'PICKUP', label: '只暂停自取', hint: '顾客仍可下外送单；自取结算页显示暂停原因' },
  { key: 'ALL_TODAY', label: '全部暂停（今天）', hint: '外送与自取都停，今天 24:00 自动恢复；邮寄不受影响' },
  { key: 'HOLIDAY', label: '休业至某日', hint: '节假日/装修整店停，含所选日期当天，次日自动恢复；邮寄不受影响' },
]

export interface PauseInput { reason: string; until: string }

/** 返回错误文案；null = 通过。todayKey 由调用方传入（utils/time.todayKey()），便于单测 */
export function validatePauseInput(scope: PauseScope, input: PauseInput, todayKey: string): string | null {
  if (!input.reason.trim()) return '请填写原因（顾客可见）'
  if (scope === 'HOLIDAY') {
    if (!input.until) return '请选择恢复营业日期'
    if (input.until < todayKey) return '恢复日期不能早于今天'
  }
  return null
}

export interface PauseState {
  paused: { reason: string; until: string | null } | null
  pickupPaused: { reason: string; until: string | null } | null
  holiday: { until: string | null; reason: string } | null
  pickupEnabled: boolean
}

export function pauseStateLines(s: PauseState): { key: 'HOLIDAY' | 'DELIVERY' | 'PICKUP'; text: string }[] {
  const out: { key: 'HOLIDAY' | 'DELIVERY' | 'PICKUP'; text: string }[] = []
  if (s.holiday) out.push({ key: 'HOLIDAY', text: `休业中：${s.holiday.reason || '休业'}（${s.holiday.until ? `${s.holiday.until.slice(5)} 后恢复` : '手动恢复'}）` })
  if (s.paused) out.push({ key: 'DELIVERY', text: `外送已暂停：${s.paused.reason || '手动暂停'}` })
  if (s.pickupEnabled && s.pickupPaused) out.push({ key: 'PICKUP', text: `自取已暂停：${s.pickupPaused.reason || '手动暂停'}` })
  return out
}

/** 「全部暂停（今天）」的截止时刻：上海当天 23:59:59。todayKey 形如 '2026-09-11' */
export function endOfTodayIso(todayKey: string): string {
  return new Date(`${todayKey}T23:59:59+08:00`).toISOString()
}
