import { z } from 'zod'

/** 销售渠道：全国邮寄 / 同城配送。一个分类（及其商品）只属于一个渠道。 */
export const CHANNELS = ['EXPRESS', 'LOCAL'] as const
export type Channel = (typeof CHANNELS)[number]
export const channelSchema = z.enum(CHANNELS)

export const CHANNEL_LABEL: Record<Channel, string> = {
  EXPRESS: '全国邮寄',
  LOCAL: '同城配送',
}

/**
 * 订单履约方式。PICKUP（到店自取）是同城渠道下的第二种履约方式（spec 2026-09-11 P14）：
 * 菜单、购物车、券的渠道校验都按 LOCAL 走，只有「怎么把货交到顾客手上」不同。
 * 写成联合类型而不是 string，是为了让 tsc 把仓库里所有 `=== 'LOCAL' ? A : B` 的二分支揪出来——
 * 那种写法会把自取单当邮寄单处理（打邮寄票、显示「填单号发货」）。
 */
export const DELIVERY_TYPES = ['EXPRESS', 'LOCAL', 'PICKUP'] as const
export type DeliveryType = (typeof DELIVERY_TYPES)[number]
export const deliveryTypeSchema = z.enum(DELIVERY_TYPES)
export const DELIVERY_TYPE_LABEL: Record<DeliveryType, string> = {
  EXPRESS: '全国邮寄',
  LOCAL: '同城配送',
  PICKUP: '到店自取',
}
export const isPickup = (deliveryType: string): boolean => deliveryType === 'PICKUP'

/** 订单 deliveryType → 渠道：LOCAL 与 PICKUP 都是同城菜单，其余一律邮寄 */
export function channelOfDeliveryType(deliveryType: string): Channel {
  return deliveryType === 'LOCAL' || deliveryType === 'PICKUP' ? 'LOCAL' : 'EXPRESS'
}

/** 读接口的 channel 查询参数：缺省 EXPRESS（保证现有小程序零改动），非法值也按 EXPRESS */
export function parseChannelQuery(raw: unknown): Channel {
  return raw === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
}
