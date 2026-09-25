/**
 * 「呼叫方式」与「配送历史」展示的纯函数（wb-escalation-display）：一单可能有多张配送单
 * （自动升级、店员取消重呼），工作台抽屉与订单详情页都要能看到第一级呼叫与升级经过，
 * 不能只看得到最后一张。服务端对应模块见 apps/server/src/services/delivery/history-view.ts
 * （正则/文案格式以那份为准，这里只管排版）。
 */
import { callStrategyLabel } from './providers.ts'

export interface EscalatedFromInfo { fromDeliveryNo: string; providersLabel: string; minutes: string }

/**
 * 在 providers.ts 的 callStrategyLabel 结果后面，追加「（只呼${运力} ${分钟} 分钟无人接，
 * 自动升级）」——只有这张配送单确实是被自动升级接续出来的（escalatedFrom 非 null）才追加。
 */
export function callStrategyLabelWithEscalation(d: {
  callStrategy?: string | null
  calledProviders?: string[] | null
  courierCompany?: string | null
  escalatedFrom: EscalatedFromInfo | null
}): string {
  const base = callStrategyLabel(d.callStrategy, d.calledProviders, d.courierCompany)
  if (!d.escalatedFrom) return base
  return `${base}（只呼${d.escalatedFrom.providersLabel} ${d.escalatedFrom.minutes} 分钟无人接，自动升级）`
}

export interface HistoryEventLite {
  id: number
  createdAt: string
  /** 旧字段 `events`（只含最新一张单）不下发这个；`history.events` 恒下发 */
  deliveryNo?: string
  displayDesc?: string | null
  statusDesc?: string | null
  source?: string | null
}

export interface HistoryEventRow {
  id: number
  at: string
  /** 只有一张配送单时不加标签（列表本来就没有歧义） */
  tag: string | null
  text: string
}

/** 抽屉「看进度」/ 订单详情「配送轨迹」的事件行：按时间合并多张单，只有一张单不加标签 */
export function historyEventRows(history: { deliveries: { deliveryNo: string }[]; events: HistoryEventLite[] }): HistoryEventRow[] {
  const singleDelivery = (history.deliveries?.length ?? 0) <= 1
  const sorted = [...history.events].sort((a, b) => {
    const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    return t !== 0 ? t : a.id - b.id
  })
  return sorted.map((ev) => ({
    id: ev.id,
    at: ev.createdAt,
    tag: singleDelivery ? null : (ev.deliveryNo ?? null),
    text: ev.displayDesc ?? ev.statusDesc ?? ev.source ?? '',
  }))
}
