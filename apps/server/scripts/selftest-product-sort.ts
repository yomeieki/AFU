/**
 * 分类内排序纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-product-sort.ts
 *
 * 规则见 src/services/product-sort.ts 头注释（2026-09-17 分类内排序设计 §4.1）。
 */
import assert from 'assert'
import { sortProducts, type SortableProduct, type CategorySortInfo } from '../src/services/product-sort'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}

function p(id: number, categoryId: number, opts: Partial<SortableProduct> = {}): SortableProduct {
  return {
    id,
    categoryId,
    isRecommended: 0,
    sortOrder: 0,
    createdAt: new Date(2026, 0, id), // 用 id 撑开天数，方便断言 createdAt 兜底
    ...opts,
  }
}

function ids(list: SortableProduct[]): number[] {
  return list.map((x) => x.id)
}

t('推荐置顶：分类 B 的一道 isRecommended=1 排第一，其余按分类顺序', () => {
  const cats = new Map<number, CategorySortInfo>([
    [1, { sortOrder: 0, productSortMode: 'MANUAL' }],
    [2, { sortOrder: 1, productSortMode: 'MANUAL' }],
  ])
  const list = [
    p(1, 1, { sortOrder: 0 }),
    p(2, 1, { sortOrder: 1 }),
    p(3, 2, { sortOrder: 0 }),
    p(4, 2, { sortOrder: 1, isRecommended: 1 }),
  ]
  const sorted = sortProducts(list, cats, new Map())
  assert.deepStrictEqual(ids(sorted), [4, 1, 2, 3])
})

t('分类顺序：category.sortOrder 小的在前；相同按 categoryId 升序', () => {
  const cats = new Map<number, CategorySortInfo>([
    [10, { sortOrder: 5, productSortMode: 'MANUAL' }],
    [5, { sortOrder: 5, productSortMode: 'MANUAL' }],
    [2, { sortOrder: 1, productSortMode: 'MANUAL' }],
  ])
  const list = [p(1, 10), p(2, 5), p(3, 2)]
  const sorted = sortProducts(list, cats, new Map())
  // 分类 2（sortOrder 1）最先；分类 5、10 的 sortOrder 都是 5，categoryId 小的（5）先
  assert.deepStrictEqual(ids(sorted), [3, 2, 1])
})

t('MANUAL：同分类按 sortOrder 升序，相同按 createdAt 升序，再相同按 id 升序', () => {
  const cats = new Map<number, CategorySortInfo>([[1, { sortOrder: 0, productSortMode: 'MANUAL' }]])
  const sameCreated = new Date(2026, 5, 1)
  const list = [
    p(3, 1, { sortOrder: 1, createdAt: sameCreated }),
    p(1, 1, { sortOrder: 0 }),
    p(2, 1, { sortOrder: 1, createdAt: sameCreated }), // 与 id=3 同 sortOrder、同 createdAt → id 兜底
  ]
  const sorted = sortProducts(list, cats, new Map())
  assert.deepStrictEqual(ids(sorted), [1, 2, 3])
})

t('SALES_30D：销量高在前；无销量记 0 排最后；销量相同按 sortOrder/createdAt/id', () => {
  const cats = new Map<number, CategorySortInfo>([[1, { sortOrder: 0, productSortMode: 'SALES_30D' }]])
  const sameCreated = new Date(2026, 5, 1)
  const list = [
    p(1, 1, { sortOrder: 0 }), // 无销量 → 0
    p(2, 1, { sortOrder: 0 }), // 销量 5
    p(3, 1, { sortOrder: 1, createdAt: sameCreated }), // 销量 2，sortOrder 1
    p(4, 1, { sortOrder: 0, createdAt: sameCreated }), // 销量 2，sortOrder 0 → 早于 id=3
  ]
  const sales = new Map([[2, 5], [3, 2], [4, 2]])
  const sorted = sortProducts(list, cats, sales)
  assert.deepStrictEqual(ids(sorted), [2, 4, 3, 1])
})

t('两种模式并存：分类 A MANUAL、分类 B SALES_30D，互不影响', () => {
  const cats = new Map<number, CategorySortInfo>([
    [1, { sortOrder: 0, productSortMode: 'MANUAL' }],
    [2, { sortOrder: 1, productSortMode: 'SALES_30D' }],
  ])
  const list = [
    p(1, 1, { sortOrder: 1 }),
    p(2, 1, { sortOrder: 0 }),
    p(3, 2, { sortOrder: 0 }),
    p(4, 2, { sortOrder: 1 }),
  ]
  const sales = new Map([[3, 1], [4, 9]])
  const sorted = sortProducts(list, cats, sales)
  // 分类 1（MANUAL）内 id=2(sortOrder0) 先于 id=1(sortOrder1)；分类 2（SALES_30D）内销量高的 id=4 先于 id=3
  assert.deepStrictEqual(ids(sorted), [2, 1, 4, 3])
})

t('分类不在传入的分类表里的商品排到最后，不抛错', () => {
  const cats = new Map<number, CategorySortInfo>([[1, { sortOrder: 0, productSortMode: 'MANUAL' }]])
  const list = [p(1, 1, { sortOrder: 0 }), p(2, 999, { sortOrder: 0 }), p(3, 1, { sortOrder: 1 })]
  const sorted = sortProducts(list, cats, new Map())
  assert.deepStrictEqual(ids(sorted), [1, 3, 2])
})

t('分页稳定：连跑两次结果一致；切片拼接等于整体前 4 项', () => {
  const cats = new Map<number, CategorySortInfo>([[1, { sortOrder: 0, productSortMode: 'MANUAL' }]])
  const list = [p(4, 1), p(2, 1), p(5, 1), p(1, 1), p(3, 1)]
  const run1 = ids(sortProducts(list, cats, new Map()))
  const run2 = ids(sortProducts(list, cats, new Map()))
  assert.deepStrictEqual(run1, run2)
  const sorted = sortProducts(list, cats, new Map())
  const page1 = sorted.slice(0, 2)
  const page2 = sorted.slice(2, 4)
  assert.deepStrictEqual(ids([...page1, ...page2]), ids(sorted.slice(0, 4)))
})

t('纯函数：不修改传入数组', () => {
  const cats = new Map<number, CategorySortInfo>([[1, { sortOrder: 0, productSortMode: 'MANUAL' }]])
  const list = [p(3, 1), p(1, 1), p(2, 1)]
  const before = ids(list)
  sortProducts(list, cats, new Map())
  assert.deepStrictEqual(ids(list), before)
})

console.log(`\n${pass} 例通过${process.exitCode ? '，存在失败' : ''}`)
