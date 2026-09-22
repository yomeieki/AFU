/**
 * 预约单在工作台上的时间语义（spec 2026-09-21 §6.1）。全部纯函数、只做减法与文案；
 * 阶段（phase）由服务端算好，这里不倒推。时刻格式化走 utils/time（Asia/Shanghai）。
 */
import { fmtHHmm } from './time.ts'
import type { ScheduleInfo, SchedulePhase, WorkbenchCard, WorkbenchSnapshot } from '../types'

export type ScheduleUrgency = '' | 'warn' | 'late'
export type ScheduleColKey = 'pending' | 'preparing' | 'waitingCourier' | 'delivering' | 'done'

const SCHEDULE_COL_KEYS: ScheduleColKey[] = ['pending', 'preparing', 'waitingCourier', 'delivering', 'done']

/**
 * 在快照的五列 + `scheduled` 桶里找一张卡片，供 Workbench 的「换列/离开看板」检测复用。
 * `scheduled`（出票前的 WAITING 预约单）不是显示列，它渲染在待接单列顶部的折叠组里——
 * 找到时 colKey 记为 `'pending'`，与 `renderCard` 里 `onOpen={() => openCard(c, col.key)}`
 * 在 `col.key === 'pending'` 分支里把这些卡片的 colKey 设成 `'pending'` 保持一致。
 * 六处都找不到才返回 null（订单已经离开看板：退款、被别的渠道/店员处理掉）。
 */
export function findCardColumn(columns: WorkbenchSnapshot['columns'], orderId: number): { card: WorkbenchCard; colKey: ScheduleColKey } | null {
  for (const key of SCHEDULE_COL_KEYS) {
    const found = columns[key].find((c) => c.orderId === orderId)
    if (found) return { card: found, colKey: key }
  }
  const foundScheduled = columns.scheduled.find((c) => c.orderId === orderId)
  if (foundScheduled) return { card: foundScheduled, colKey: 'pending' }
  return null
}

const minLeft = (iso: string, now: number) => Math.ceil((Date.parse(iso) - now) / 60_000)
const minOver = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))

/** 紧急度只看阶段：应备好未备好 = 橙，超约定时间 = 红。其余不点亮（有硬期限的单不用等待时长那把尺子） */
export function scheduleUrgency(phase: SchedulePhase): ScheduleUrgency {
  if (phase === 'LATE') return 'late'
  if (phase === 'CALL_DUE') return 'warn'
  return ''
}

/** 卡片右上角胶囊文案。done 列不归这里管（返回 null 走「完成于」） */
export function scheduleCapsule(sc: ScheduleInfo, colKey: ScheduleColKey, now: number): { text: string; cls: string } | null {
  if (colKey === 'done') return null
  const cls = scheduleUrgency(sc.phase) === 'late' ? 'wb__wait--danger' : scheduleUrgency(sc.phase) === 'warn' ? 'wb__wait--warn' : ''
  switch (sc.phase) {
    case 'WAITING':
    case 'TICKETED':
      return { text: `${fmtHHmm(sc.prepStartAt)} 开始备餐`, cls }
    case 'PREPPING':
      return { text: `距应备好 ${minLeft(sc.callAt, now)} 分`, cls }
    case 'CALL_DUE':
      return { text: `应已备好 · 晚 ${minOver(sc.callAt, now)} 分`, cls }
    case 'READY_WAITING':
      return { text: `已备好 · ${fmtHHmm(sc.callAt)} 自动呼叫`, cls }
    case 'CALLED':
      return { text: `${fmtHHmm(sc.scheduledAt)} 送达`, cls }
    case 'LATE':
      return { text: `已超约定时间 ${minOver(sc.scheduledAt, now)} 分`, cls }
  }
}

/** 折叠进「预约单」组：出票前（WAITING）且没有取消申请——红框告警卡必须留在正常列 */
export function scheduleFoldable(card: WorkbenchCard): boolean {
  const sc = card.local?.schedule
  return !!sc && sc.phase === 'WAITING' && !card.local?.cancelRequested
}

/** 顶部常驻倒计时条文案 */
export function scheduleBarText(bar: { prepStartAt: string; slotLabel: string; count: number }, now: number): string {
  const left = minLeft(bar.prepStartAt, now)
  const when = left > 0 ? `还有 ${left} 分钟` : `已到点 ${-left} 分钟`
  const more = bar.count > 1 ? ` · 另有 ${bar.count - 1} 张` : ''
  return `下一张预约单 ${fmtHHmm(bar.prepStartAt)} 开始备餐，${when}（${bar.slotLabel} 送达）${more}`
}

/** 「现在呼叫预计 12:05 送达」 */
export function etaTextIfCallNow(sc: ScheduleInfo): string {
  return `现在呼叫预计 ${fmtHHmm(sc.etaIfCallNow)} 送达`
}

/** 早于「该呼叫 − 容忍」：点「呼叫」要走 force 并二次确认 */
export function isBeforeCallWindow(sc: ScheduleInfo, now: number): boolean {
  return now < Date.parse(sc.callAt) - sc.callToleranceMin * 60_000
}

/** 卡片字段区那一行「12:00 送达 · 11:16 开始备餐 · 11:36 呼叫」 */
export function scheduleFieldsLine(sc: ScheduleInfo): string {
  return `${sc.slotLabel} 送达 · ${fmtHHmm(sc.prepStartAt)} 开始备餐 · ${fmtHHmm(sc.callAt)} 呼叫`
}
