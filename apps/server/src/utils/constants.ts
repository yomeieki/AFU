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

/** 已付款超时未接单的默认催单阈值（分钟）。挪到这里是为了让 scheduler.ts 与 services/pickup-tasks.ts
 * 都能 import 而不产生循环依赖（两者互相引用对方的导出）。 */
export const ACCEPT_REMIND_AFTER_MIN = 15
