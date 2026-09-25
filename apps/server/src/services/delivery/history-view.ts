/**
 * 配送单「历史」展示的纯函数集合：解析自动升级留下的取消理由、拼历史行文案、判定链路归属、
 * 算等待锚点。无 DB、无副作用——routes/admin/delivery.ts（详情接口）、
 * routes/admin/workbench.ts（等待锚点）与 scripts/selftest-delivery-core.ts（自测）共用，
 * 正则与文案格式只许写这一份。
 *
 * 背景（wb-escalation-display，2026-09）：一单可能有多张配送单（自动升级：先呼一家 3 分钟
 * 无人接、系统自动取消并改呼三家；店员手动取消重呼同理）。此前接口只回最新一张 + 它的事件，
 * 工作台与订单详情都只看得到「第二张单」，第一级呼叫与升级经过整段消失。
 */
import { providerLabel } from './state'

/** tasks.ts escalateSoloCalls 写入 cancelReason 的固定格式；改这个正则前先看 tasks.ts:344 的字面量是否也要同步改 */
export const AUTO_ESCALATION_REASON_RE = /^(\d+(?:\.\d+)?)\s*分钟无人接单，自动升级为(.+)$/

export function parseAutoEscalationReason(reason: string | null | undefined): { minutes: string; rungText: string } | null {
  if (!reason) return null
  const m = AUTO_ESCALATION_REASON_RE.exec(reason)
  if (!m) return null
  return { minutes: m[1], rungText: m[2] }
}

/** calledProviders（Delivery.calledProviders Json 列）→ 「达达、蜂鸟」这样的顿号连接文案 */
function calledProvidersLabel(v: unknown): string {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(providerLabel).join('、') : ''
}

export function autoEscalationCancelDesc(input: { providersLabel: string; minutes: string; feeYuan: string; rungText: string }): string {
  const label = input.providersLabel || '运力'
  return `${label} ${input.minutes} 分钟无人接，已自动取消（取消费 ¥${input.feeYuan}），改为${input.rungText}`
}

const LEGACY_CANCEL_DESC_RE = /^商家取消（取消费 (\d+\.\d{2}) 元）(.*)$/

/**
 * 历史行改写：旧数据里自动升级留下的事件文案仍是「商家取消（取消费 X 元）」（S2 之前写死的
 * 字面量），店员分不清是自己点的取消还是系统自动升级。只在能同时确认「事件确实来自调度器」
 * 与「配送单确实是被自动升级取消」两个条件时才改写展示层文案，不动库里的 statusDesc 原值。
 */
export function legacyDisplayDesc(
  ev: { source: string | null; operator: string | null; statusDesc: string | null },
  d: { cancelReason: string | null; calledProviders?: unknown },
): string | null {
  if (ev.statusDesc == null) return null
  if (ev.source !== 'ADMIN' || ev.operator !== 'scheduler') return ev.statusDesc
  const m = LEGACY_CANCEL_DESC_RE.exec(ev.statusDesc)
  if (!m) return ev.statusDesc
  const parsed = parseAutoEscalationReason(d.cancelReason)
  if (!parsed) return ev.statusDesc
  const feeYuan = m[1]
  const tail = m[2] ?? ''
  return `${autoEscalationCancelDesc({ providersLabel: calledProvidersLabel(d.calledProviders), minutes: parsed.minutes, feeYuan, rungText: parsed.rungText })}${tail}`
}

export interface EscalatedFrom { fromDeliveryNo: string; providersLabel: string; minutes: string }

export interface DeliveryChainLite {
  id: number
  deliveryNo: string
  status: string
  operator: string | null
  callOrigin: string | null
  cancelReason: string | null
  calledProviders?: unknown
}

/**
 * d 是否「由自动升级从 all 中的前一张接续而来」。all 需按 id 升序排列（本函数内部也会重排一次，
 * 不依赖调用方守规矩）。只识别自动升级——店员手动取消重呼、骑手接单后取消重呼都不命中，
 * 它们不该显示「自动升级」这句话（但仍然计入等待锚点，等待锚点走 waitAnchorFor，与本函数无关）。
 */
export function escalatedFrom<T extends DeliveryChainLite>(d: T, all: T[]): EscalatedFrom | null {
  const sorted = [...all].sort((a, b) => a.id - b.id)
  const idx = sorted.findIndex((x) => x.id === d.id)
  if (idx <= 0) return null
  const prev = sorted[idx - 1]
  if (prev.status !== 'CANCELLED') return null
  const parsed = parseAutoEscalationReason(prev.cancelReason)
  if (!parsed) return null
  if (d.operator !== 'scheduler' || d.callOrigin != null) return null
  return { fromDeliveryNo: prev.deliveryNo, providersLabel: calledProvidersLabel(prev.calledProviders), minutes: parsed.minutes }
}

export interface WaitAnchorLite extends DeliveryChainLite {
  calledAt: Date | null
  createdAt: Date
}

/**
 * 等待计时口径（用户 2026-09-26 决定，复核第 1 轮后追加 R5/R6，见 plan-decisions.md 第 7/8 条）：
 * 一律从这一单**第一次呼叫**算起——自动升级、店员取消重呼、骑手接单后取消重呼、**呼叫失败
 * 重呼（R5）**都不清零；唯一例外是**预约单「立即呼叫」（callOrigin=MANUAL_EARLY）** 那次：
 * 如果它后来被取消/失败、到点又重新呼叫了一次，锚点从「到点那次」算，提前那次不计入（R6）；
 * 但如果 MANUAL_EARLY 那次通过自动升级一路延续到了当前在途单（同一条链），仍从它算——
 * 用户没有表达过「重新等」，是系统自己把它撤了又续上的。
 *
 * 算法：先把 all 按 id 升序分链（下一张若是自动升级接续上一张，算同一条链，见 escalatedFrom）；
 * 找到 active 所在的那条链（active 不在 all 里时自成一链）；候选链 = active 所在链，加上所有
 * 链头不是 MANUAL_EARLY 的链；候选链里取「链头 calledAt ?? createdAt」最早的那个。
 */
export function waitAnchorFor(active: WaitAnchorLite, all: WaitAnchorLite[]): Date {
  const list = all.length ? all : [active]
  const sorted = [...list].sort((a, b) => a.id - b.id)
  const anchorOf = (d: WaitAnchorLite) => d.calledAt ?? d.createdAt

  const chains: WaitAnchorLite[][] = []
  for (const d of sorted) {
    const prevChain = chains[chains.length - 1]
    if (prevChain && escalatedFrom(d, sorted) !== null) prevChain.push(d)
    else chains.push([d])
  }
  const activeChain = chains.find((c) => c.some((d) => d.id === active.id)) ?? [active]
  const candidates = chains.filter((c) => c === activeChain || c[0].callOrigin !== 'MANUAL_EARLY')
  const earliestChain = candidates.reduce(
    (min, c) => (anchorOf(c[0]).getTime() < anchorOf(min[0]).getTime() ? c : min),
    candidates[0] ?? activeChain,
  )
  return anchorOf(earliestChain[0])
}

export interface DeliveryEventLite {
  id: number
  createdAt: Date
  source: string | null
  operator: string | null
  statusDesc: string | null
  [key: string]: unknown
}

export interface DeliveryHistoryInput extends DeliveryChainLite {
  orderId: number
  provider: string | null
  callStrategy: string | null
  courierCompany: string | null
  calledAt: Date | null
  acceptedAt: Date | null
  cancelledAt: Date | null
  cancelFee: number
  createdAt: Date
  events: DeliveryEventLite[]
}

export interface DeliverySummary {
  id: number; orderId: number; deliveryNo: string; seq: number; status: string; provider: string | null
  callStrategy: string | null; calledProviders: unknown; courierCompany: string | null
  operator: string | null; callOrigin: string | null
  calledAt: Date | null; acceptedAt: Date | null; cancelledAt: Date | null
  cancelReason: string | null; cancelFee: number
  escalatedFrom: EscalatedFrom | null
}

export interface PresentedDeliveryEvent extends DeliveryEventLite {
  deliveryNo: string; deliverySeq: number; displayDesc: string | null
}

const time = (x: Date | string) => (x instanceof Date ? x.getTime() : new Date(x).getTime())

/** 详情接口的 `history` 字段：全部配送单摘要（含链路归属）+ 全部事件（按时间合并、按单打标签） */
export function presentDeliveryHistory(all: DeliveryHistoryInput[]): {
  deliveries: DeliverySummary[]; events: PresentedDeliveryEvent[]; firstCalledAt: Date | null
} {
  const sorted = [...all].sort((a, b) => a.id - b.id)
  const seqOf = new Map(sorted.map((d, i) => [d.id, i + 1]))
  const deliveries: DeliverySummary[] = sorted.map((d) => ({
    id: d.id, orderId: d.orderId, deliveryNo: d.deliveryNo, seq: seqOf.get(d.id)!, status: d.status,
    provider: d.provider, callStrategy: d.callStrategy, calledProviders: d.calledProviders ?? null,
    courierCompany: d.courierCompany, operator: d.operator, callOrigin: d.callOrigin,
    calledAt: d.calledAt, acceptedAt: d.acceptedAt, cancelledAt: d.cancelledAt,
    cancelReason: d.cancelReason, cancelFee: d.cancelFee,
    escalatedFrom: escalatedFrom(d, sorted),
  }))
  const events: PresentedDeliveryEvent[] = sorted
    .flatMap((d) => (d.events ?? []).map((ev) => ({
      ...ev, deliveryNo: d.deliveryNo, deliverySeq: seqOf.get(d.id)!, displayDesc: legacyDisplayDesc(ev, d),
    })))
    .sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.id - b.id)
  // 「active」用最后一张（id 最大）：正常情况下它就是当前在途/最终那一张，与
  // routes/admin/delivery.ts 的 `delivery`（findFirst orderBy id desc）同一口径。
  const firstCalledAt = sorted.length ? waitAnchorFor(sorted[sorted.length - 1], sorted) : null
  return { deliveries, events, firstCalledAt }
}
