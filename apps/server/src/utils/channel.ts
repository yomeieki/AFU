import { z } from 'zod'

/** 销售渠道：全国邮寄 / 同城配送。一个分类（及其商品）只属于一个渠道。 */
export const CHANNELS = ['EXPRESS', 'LOCAL'] as const
export type Channel = (typeof CHANNELS)[number]
export const channelSchema = z.enum(CHANNELS)

export const CHANNEL_LABEL: Record<Channel, string> = {
  EXPRESS: '全国邮寄',
  LOCAL: '同城配送',
}

/** 订单 deliveryType → 渠道（现有列语义复用：LOCAL 即同城，其余一律邮寄） */
export function channelOfDeliveryType(deliveryType: string): Channel {
  return deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
}

/** 读接口的 channel 查询参数：缺省 EXPRESS（保证现有小程序零改动），非法值也按 EXPRESS */
export function parseChannelQuery(raw: unknown): Channel {
  return raw === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
}
