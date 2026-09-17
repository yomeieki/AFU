/**
 * 全店自动满减（2026-09-17 设计 §4）——满减规则的**唯一实现**。
 *
 * 全部是纯函数：不 import prisma、不抛 AppError、`now` 必传。
 * `now` 必传是因为自测要钉住时刻（活动是否 active 依赖当前时间），调用方
 * （下单链路 / 只读接口）自己传 `new Date()`，这里不悄悄取「当前时间」。
 *
 * 渠道用 `PromoChannel`，键直接是 `DeliveryType`（`LOCAL`/`PICKUP`/`EXPRESS`）——
 * 不像优惠券的渠道那样二分（LOCAL 菜单 vs EXPRESS 菜单，`utils/channel.ts` 的
 * `channelOfDeliveryType`），满减是三分的：自取与外送虽然同属 LOCAL 菜单，
 * 但满减要能分别开关（自取默认不勾，避免叠加自取折扣亏本）。两套「渠道」概念
 * 不合并，各自服务各自的判定，读的地方各读各的。
 */
import type { LocalDeliverySettings, PromoChannel, PromotionSettings } from './local-settings'

export function isPromoActive(s: LocalDeliverySettings, now: Date): boolean {
  const p = s.promotion
  if (!p.enabled) return false
  if (p.startAt !== null && now < new Date(p.startAt)) return false
  if (p.endAt !== null && now >= new Date(p.endAt)) return false
  return true
}

/**
 * 命中的档：所有 `subtotalFen >= minFen` 的档里取 `cutFen` **最大**的一档（P2：不叠加多档，
 * 也不是取最后一档——店主在后台把档位顺序打乱，结果也不该变）。
 * 返回值恒 `>= 0` 且 `< subtotalFen`：sanitize 已经校验过 `cutFen < minFen <= subtotalFen`。
 */
export function promoDiscountOf(
  s: LocalDeliverySettings,
  subtotalFen: number,
  channel: PromoChannel,
  now: Date,
): number {
  if (!isPromoActive(s, now)) return 0
  if (s.promotion.channels[channel] === false) return 0
  let best = 0
  for (const t of s.promotion.tiers) {
    if (subtotalFen >= t.minFen && t.cutFen > best) best = t.cutFen
  }
  return best
}

export interface PromoPreview {
  active: boolean
  discountFen: number
  nextTierMinFen: number | null
  nextTierCutFen: number | null
  nextTierGapFen: number | null
}

/**
 * 本单预览：已经减了多少、距下一个「值得再买」的档还差多少。
 *
 * 「下一档」= 按 minFen 升序第一条满足 `minFen > subtotalFen && cutFen > discountFen` 的档——
 * 减得不比当前多的档不算「值得再买」（例如乱配的三档 [5000→800, 8000→600, 10000→1200]，
 * 小计 6000 时已经命中 800，8000 那档虽然门槛更高但只减 600，跳过它指向 10000）。
 */
export function promoPreviewOf(
  s: LocalDeliverySettings,
  subtotalFen: number,
  channel: PromoChannel,
  now: Date,
): PromoPreview {
  const active = isPromoActive(s, now) && s.promotion.channels[channel] !== false
  if (!active) {
    return { active: false, discountFen: 0, nextTierMinFen: null, nextTierCutFen: null, nextTierGapFen: null }
  }
  const discountFen = promoDiscountOf(s, subtotalFen, channel, now)
  const sorted = [...s.promotion.tiers].sort((a, b) => a.minFen - b.minFen)
  const next = sorted.find((t) => t.minFen > subtotalFen && t.cutFen > discountFen)
  return {
    active: true,
    discountFen,
    nextTierMinFen: next ? next.minFen : null,
    nextTierCutFen: next ? next.cutFen : null,
    nextTierGapFen: next ? next.minFen - subtotalFen : null,
  }
}

/** 给 `/local/meta` 用：不 active 也照常给结构，`active:false`，让客户端字段形状稳定 */
export function publicPromotionView(s: LocalDeliverySettings, now: Date = new Date()) {
  const p: PromotionSettings = s.promotion
  return {
    active: isPromoActive(s, now),
    name: p.name,
    startAt: p.startAt,
    endAt: p.endAt,
    channels: p.channels,
    tiers: [...p.tiers].sort((a, b) => a.minFen - b.minFen),
  }
}
