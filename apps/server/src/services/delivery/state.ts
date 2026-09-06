/** 配送单状态机常量。改这里前先读 spec §5.3——rank 单调是回调幂等的另一半。 */
export const DELIVERY_RANK: Record<string, number> = {
  PENDING: 0, CALLING: 10, ACCEPTED: 20, ARRIVING: 30, ARRIVED: 40, DELIVERING: 50, DELIVERED: 100,
}
export const TERMINAL = ['DELIVERED', 'CANCELLED', 'FAILED'] as const

type RankEntry = { type: 'rank'; status: keyof typeof DELIVERY_RANK & string; rank: number; stamp?: 'acceptedAt' | 'pickedUpAt' | 'deliveredAt' }
type SideEntry = { type: 'side'; status: 'REASSIGNING' | 'ABNORMAL' | 'CANCELLED' }
export const PROVIDER_STATUS_MAP: Record<string, RankEntry | SideEntry> = {
  '0':   { type: 'rank', status: 'CALLING',    rank: 10 },
  '100': { type: 'rank', status: 'ACCEPTED',   rank: 20, stamp: 'acceptedAt' },
  '210': { type: 'rank', status: 'ARRIVING',   rank: 30 },
  '230': { type: 'rank', status: 'ARRIVED',    rank: 40 },
  '310': { type: 'rank', status: 'DELIVERING', rank: 50, stamp: 'pickedUpAt' },
  '520': { type: 'rank', status: 'DELIVERED',  rank: 100, stamp: 'deliveredAt' },
  '515': { type: 'side', status: 'REASSIGNING' },
  '510': { type: 'side', status: 'ABNORMAL' },
  '720': { type: 'side', status: 'CANCELLED' },
}
/**
 * 运力编码 → 中文名。用在事件文案与告警里（「只呼 达达 ¥16.23」比「只呼 dadatongcheng」
 * 对店员有用得多）。管理端另有一份同表的 apps/admin/src/utils/providers.ts 供界面用——
 * 两处都只是显示层，唯一真相仍是 local-settings.ts 的 KD100_PROVIDERS。
 * 未收录的编码原样返回，不猜、不留空。
 */
export const PROVIDER_LABEL: Record<string, string> = {
  dadatongcheng: '达达', fengniaotongcheng: '蜂鸟', shunfengtongcheng: '顺丰同城',
  shansongtongcheng: '闪送', meituantongcheng: '美团', uupaotui: 'UU跑腿', gxdtongcheng: '裹小递',
}
export const providerLabel = (code: string | null | undefined): string =>
  (code ? PROVIDER_LABEL[code] ?? code : '')

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  PENDING: '待呼叫', CALLING: '待抢单', ACCEPTED: '骑手已接单', ARRIVING: '骑手赶来取货',
  ARRIVED: '骑手已到店', DELIVERING: '配送中', REASSIGNING: '改派中', ABNORMAL: '配送异常',
  DELIVERED: '已送达', CANCELLED: '已取消', FAILED: '呼叫失败', UNKNOWN: '状态未确认',
}
