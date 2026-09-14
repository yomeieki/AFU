/**
 * 餐具规则的唯一来源（2026-09-14 餐具选择设计）。
 * 纯模块，不 import prisma：下单校验、落库列、小票与工作台文案都从这里取，selftest 不起库就能跑。
 */
import { z } from 'zod'

export const TABLEWARE_MODES = ['NONE', 'BY_MEAL', 'COUNT'] as const
export type TablewareMode = (typeof TABLEWARE_MODES)[number]
export const TABLEWARE_MAX = 10

export const tablewareSchema = z
  .object({
    mode: z.enum(TABLEWARE_MODES, { message: '餐具选项无效' }),
    count: z.number().int('餐具份数为 1–10 份').min(1, '餐具份数为 1–10 份').max(TABLEWARE_MAX, '餐具份数为 1–10 份').optional(),
  })
  // 指定份数时必须带 count；其余两种不得带——带了说明客户端状态机错位，宁可拒也不猜
  .refine((t) => (t.mode === 'COUNT') === (t.count !== undefined), { message: '指定餐具份数时请填写 1–10 份' })

/** 旧版小程序把「需要餐具」拼在备注前面（占掉 20 字里的 7 个）。服务端在 zod 解析之前剥掉并补成按餐量（T9） */
export const LEGACY_TABLEWARE_PREFIX = /^\[需要餐具\]\s*/

export function applyLegacyTablewarePrefix(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const b = body as Record<string, unknown>
  if (typeof b.remark !== 'string' || !LEGACY_TABLEWARE_PREFIX.test(b.remark)) return body
  const remark = b.remark.replace(LEGACY_TABLEWARE_PREFIX, '')
  return { ...b, remark: remark || undefined, tableware: b.tableware ?? { mode: 'BY_MEAL' } }
}

export function tablewareColumns(
  deliveryType: string,
  t: { mode: TablewareMode; count?: number } | undefined,
): { tablewareMode: TablewareMode | null; tablewareCount: number | null } {
  // 邮寄单没有餐具（T1）；同城/自取没选（旧版客户端）也不拒单，记 null（T9）
  if ((deliveryType !== 'LOCAL' && deliveryType !== 'PICKUP') || !t) return { tablewareMode: null, tablewareCount: null }
  return { tablewareMode: t.mode, tablewareCount: t.mode === 'COUNT' ? (t.count ?? null) : null }
}

export function tablewareLabel(mode: string | null | undefined, count: number | null | undefined): string {
  if (mode === 'NONE') return '无需餐具'
  if (mode === 'BY_MEAL') return '需要餐具 · 按餐量'
  if (mode === 'COUNT' && count) return `需要餐具 · ${count} 份`
  return ''
}

export function tablewareTicketText(mode: string | null | undefined, count: number | null | undefined): string {
  if (mode === 'NONE') return '无需餐具'
  if (mode === 'BY_MEAL') return '餐具：按餐量'
  if (mode === 'COUNT' && count) return `餐具：${count} 份`
  return ''
}
