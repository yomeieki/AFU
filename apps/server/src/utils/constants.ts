/** 库存预警阈值：上架商品库存 ≤ 此值视为低库存（后台徽标 + 企微推送共用） */
export const LOW_STOCK_THRESHOLD = 5

/** 售后原因枚举与展示文案（小程序与后台共用） */
export const AFTER_SALE_REASONS = ['SHORTAGE', 'WRONG', 'DAMAGED', 'OTHER'] as const
export type AfterSaleReason = (typeof AFTER_SALE_REASONS)[number]
export const AFTER_SALE_REASON_LABEL: Record<AfterSaleReason, string> = {
  SHORTAGE: '少发/漏发',
  WRONG: '错发',
  DAMAGED: '变质/破损',
  OTHER: '其他',
}

/** 待付款订单超时时间（毫秒），由 config.order.payTimeoutMin 派生 */
export function payExpireAtOf(createdAt: Date, timeoutMin: number): Date {
  return new Date(createdAt.getTime() + timeoutMin * 60 * 1000)
}
