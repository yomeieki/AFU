/**
 * 分类内商品排序——公开列表（routes/products.ts）与后台列表（routes/admin/products.ts）
 * 共用的唯一实现，规则不得在别处复刻（2026-09-17 分类内排序设计 §4.1）。
 *
 * 纯函数，无 I/O，不修改入参：调用方负责把商品行、分类的排序信息、近 30 天销量聚合都查好传进来。
 *
 * 排序规则（逐字）：
 *   1. isRecommended 降序（首页取前 6 靠它）；
 *   2. 分类 sortOrder 升序，相同再按 categoryId 升序；
 *   3. 分类内：MANUAL → 商品 sortOrder 升序，相同 createdAt 升序；
 *      SALES_30D → 近 30 天销量降序，相同 sortOrder 升序、再 createdAt 升序；
 *   4. 最后 id 升序兜底，保证分页稳定。
 * 商品所属分类不在传入的分类表里（理论上不会发生）→ 视为 sortOrder = Number.MAX_SAFE_INTEGER、
 * MANUAL，排到最后而不是抛错。
 *
 * 调用方式：sortProducts(rows, categoryMap, salesMap)。全仓库只有两处调用，
 * 见 routes/products.ts（公开列表）与 routes/admin/products.ts（后台列表）。
 */

export const PRODUCT_SORT_MODES = ['MANUAL', 'SALES_30D'] as const
export type ProductSortMode = (typeof PRODUCT_SORT_MODES)[number]

export interface SortableProduct {
  id: number
  categoryId: number
  isRecommended: number
  sortOrder: number
  createdAt: Date
}

export interface CategorySortInfo {
  sortOrder: number
  productSortMode: ProductSortMode
}

const FALLBACK_CATEGORY: CategorySortInfo = { sortOrder: Number.MAX_SAFE_INTEGER, productSortMode: 'MANUAL' }

/** 返回新数组，不改入参。规则见 2026-09-17 设计 §4.1。 */
export function sortProducts<T extends SortableProduct>(
  list: readonly T[],
  categories: ReadonlyMap<number, CategorySortInfo>,
  sales30d: ReadonlyMap<number, number>,
): T[] {
  return [...list].sort((a, b) => {
    // 1. 推荐置顶
    if (a.isRecommended !== b.isRecommended) return b.isRecommended - a.isRecommended

    const catA = categories.get(a.categoryId) ?? FALLBACK_CATEGORY
    const catB = categories.get(b.categoryId) ?? FALLBACK_CATEGORY

    // 2. 分类 sortOrder 升序，相同按 categoryId 升序
    if (catA.sortOrder !== catB.sortOrder) return catA.sortOrder - catB.sortOrder
    if (a.categoryId !== b.categoryId) return a.categoryId - b.categoryId

    // 3. 分类内：两个商品必然同分类，模式取其一即可
    if (catA.productSortMode === 'SALES_30D') {
      const salesA = sales30d.get(a.id) ?? 0
      const salesB = sales30d.get(b.id) ?? 0
      if (salesA !== salesB) return salesB - salesA
    }
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    const createdDiff = a.createdAt.getTime() - b.createdAt.getTime()
    if (createdDiff !== 0) return createdDiff

    // 4. 兜底
    return a.id - b.id
  })
}
