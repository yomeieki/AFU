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
export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  PENDING: '待呼叫', CALLING: '待抢单', ACCEPTED: '骑手已接单', ARRIVING: '骑手赶来取货',
  ARRIVED: '骑手已到店', DELIVERING: '配送中', REASSIGNING: '改派中', ABNORMAL: '配送异常',
  DELIVERED: '已送达', CANCELLED: '已取消', FAILED: '呼叫失败', UNKNOWN: '状态未确认',
}
