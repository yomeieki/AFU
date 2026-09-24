import type { LowStockGroup, Channel, Product } from '../types'

/**
 * 商品列表「N 个规格售罄/紧张」标签（2026-09-24）。无规格商品最多算 1 个单位，
 * 文案不带「规格」二字（「已售罄」/「库存紧张」），避免「1 个规格售罄」这种对无规格商品说不通的话。
 */
export function stockAlertLabel(alert: { out: number; low: number }, hasSkus: boolean): string {
  if (alert.out === 0 && alert.low === 0) return ''
  if (!hasSkus) return alert.out > 0 ? '已售罄' : '库存紧张'
  const parts: string[] = []
  if (alert.out > 0) parts.push(`${alert.out} 个规格售罄`)
  if (alert.low > 0) parts.push(`${alert.low} 个紧张`)
  return parts.join(' · ')
}

export interface LowStockFilter {
  level?: 'OUT' | 'LOW' | null
  channel?: Channel | null
}

/** 按档位/渠道筛选组：level 筛选时组内也只留命中的单位，命中 0 个的组整组去掉 */
export function filterLowStockGroups(groups: LowStockGroup[], filter: LowStockFilter): LowStockGroup[] {
  const { level, channel } = filter
  return groups
    .filter((g) => !channel || g.channel === channel)
    .map((g) => (level ? { ...g, units: g.units.filter((u) => u.level === level) } : g))
    .filter((g) => !level || g.units.length > 0)
}

/** 从（可能已筛选过的）组列表里现算计数，不依赖组上过期的 out/low 字段 */
export function countLowStock(groups: LowStockGroup[]): { total: number; out: number; low: number } {
  let out = 0
  let low = 0
  for (const g of groups) {
    for (const u of g.units) {
      if (u.level === 'OUT') out++
      else low++
    }
  }
  return { total: out + low, out, low }
}

/** 单个库存单位的展示文案 */
export function unitLabel(stock: number): string {
  return stock <= 0 ? '售罄' : `剩 ${stock} 份`
}

/**
 * 局部更新列表里的一项（2026-09-24 修订 2，R2-3）：上下架/改库存后不整页刷新，
 * 直接把接口响应里的 patch（可能含 status/stock/stockAlert 等任意子集）合并进去。
 * `patch` 里没带的字段（包括没带 stockAlert）保持原值不变——这就是普通对象展开的语义，
 * 不需要为「没带」和「显式传 undefined」区分特殊逻辑。
 */
export function mergeProductPatch(list: Product[], id: number, patch: Partial<Product>): Product[] {
  return list.map((p) => (p.id === id ? { ...p, ...patch } : p))
}
