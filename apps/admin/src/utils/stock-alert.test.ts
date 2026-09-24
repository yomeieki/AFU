import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stockAlertLabel, filterLowStockGroups, countLowStock, unitLabel, mergeProductPatch, parseStockInput } from './stock-alert.ts'
import type { LowStockGroup, Product } from '../types'

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    categoryId: 1,
    name: '测试商品',
    subtitle: null,
    coverImage: null,
    price: 100,
    originalPrice: null,
    stock: 10,
    unit: '份',
    weight: null,
    shelfLife: null,
    storageMethod: null,
    deliveryInfo: null,
    description: null,
    status: 'ON_SHELF',
    deliveryType: 'EXPRESS',
    channel: 'EXPRESS',
    netWeightG: null,
    packingFeeFen: null,
    isRecommended: 0,
    salesCount: 0,
    sortOrder: 0,
    qrScene: null,
    qrCodeUrl: null,
    qrGeneratedAt: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    stockAlert: { out: 0, low: 0 },
    ...overrides,
  }
}

test('stockAlertLabel：有规格', () => {
  assert.equal(stockAlertLabel({ out: 1, low: 0 }, true), '1 个规格售罄')
  assert.equal(stockAlertLabel({ out: 2, low: 3 }, true), '2 个规格售罄 · 3 个紧张')
})
test('stockAlertLabel：无规格', () => {
  assert.equal(stockAlertLabel({ out: 0, low: 1 }, false), '库存紧张')
  assert.equal(stockAlertLabel({ out: 1, low: 0 }, false), '已售罄')
})
test('stockAlertLabel：无预警时返回空字符串', () => {
  assert.equal(stockAlertLabel({ out: 0, low: 0 }, true), '')
  assert.equal(stockAlertLabel({ out: 0, low: 0 }, false), '')
})

function group(overrides: Partial<LowStockGroup> = {}): LowStockGroup {
  return {
    productId: 1,
    productName: '测试商品',
    channel: 'LOCAL',
    coverImage: null,
    hasSkus: true,
    out: 0,
    low: 0,
    units: [],
    ...overrides,
  }
}

test('filterLowStockGroups：level=OUT 只留有售罄单位的组且组内只留售罄单位', () => {
  const groups: LowStockGroup[] = [
    group({
      productId: 1,
      out: 1,
      low: 1,
      units: [
        { key: 'sku:1', skuId: 1, specText: 'A', stock: 0, level: 'OUT' },
        { key: 'sku:2', skuId: 2, specText: 'B', stock: 1, level: 'LOW' },
      ],
    }),
    group({
      productId: 2,
      low: 1,
      units: [{ key: 'sku:3', skuId: 3, specText: 'C', stock: 1, level: 'LOW' }],
    }),
  ]
  const filtered = filterLowStockGroups(groups, { level: 'OUT' })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].productId, 1)
  assert.deepEqual(filtered[0].units.map((u) => u.key), ['sku:1'])
})

test('filterLowStockGroups：channel=LOCAL 只留同城组', () => {
  const groups: LowStockGroup[] = [
    group({ productId: 1, channel: 'LOCAL', units: [{ key: 'sku:1', skuId: 1, specText: 'A', stock: 0, level: 'OUT' }] }),
    group({ productId: 2, channel: 'EXPRESS', units: [{ key: 'sku:2', skuId: 2, specText: 'B', stock: 0, level: 'OUT' }] }),
  ]
  const filtered = filterLowStockGroups(groups, { channel: 'LOCAL' })
  assert.deepEqual(filtered.map((g) => g.productId), [1])
})

test('filterLowStockGroups：level 与 channel 叠加', () => {
  const groups: LowStockGroup[] = [
    group({
      productId: 1,
      channel: 'LOCAL',
      units: [
        { key: 'sku:1', skuId: 1, specText: 'A', stock: 0, level: 'OUT' },
        { key: 'sku:2', skuId: 2, specText: 'B', stock: 1, level: 'LOW' },
      ],
    }),
    group({
      productId: 2,
      channel: 'EXPRESS',
      units: [{ key: 'sku:3', skuId: 3, specText: 'C', stock: 0, level: 'OUT' }],
    }),
    group({
      productId: 3,
      channel: 'LOCAL',
      units: [{ key: 'sku:4', skuId: 4, specText: 'D', stock: 1, level: 'LOW' }],
    }),
  ]
  const filtered = filterLowStockGroups(groups, { level: 'OUT', channel: 'LOCAL' })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].productId, 1)
  assert.deepEqual(filtered[0].units.map((u) => u.key), ['sku:1'])
})

test('countLowStock：与手算一致', () => {
  const groups: LowStockGroup[] = [
    group({
      productId: 1,
      units: [
        { key: 'sku:1', skuId: 1, specText: 'A', stock: 0, level: 'OUT' },
        { key: 'sku:2', skuId: 2, specText: 'B', stock: 1, level: 'LOW' },
      ],
    }),
    group({
      productId: 2,
      units: [
        { key: 'sku:3', skuId: 3, specText: 'C', stock: 0, level: 'OUT' },
        { key: 'sku:4', skuId: 4, specText: 'D', stock: 2, level: 'LOW' },
        { key: 'sku:5', skuId: 5, specText: 'E', stock: 0, level: 'OUT' },
      ],
    }),
  ]
  assert.deepEqual(countLowStock(groups), { total: 5, out: 3, low: 2 })
})
test('countLowStock：空组返回全 0', () => {
  assert.deepEqual(countLowStock([]), { total: 0, out: 0, low: 0 })
})

test('unitLabel：0 → 售罄，否则「剩 N 份」', () => {
  assert.equal(unitLabel(0), '售罄')
  assert.equal(unitLabel(1), '剩 1 份')
  assert.equal(unitLabel(5), '剩 5 份')
})

// mergeProductPatch（2026-09-24 修订 2，R2-3）
test('mergeProductPatch：合并 status 与 stockAlert', () => {
  const list = [product({ id: 1, status: 'ON_SHELF', stockAlert: { out: 1, low: 0 } })]
  const next = mergeProductPatch(list, 1, { status: 'OFF_SHELF', stockAlert: { out: 0, low: 0 } })
  assert.equal(next[0].status, 'OFF_SHELF')
  assert.deepEqual(next[0].stockAlert, { out: 0, low: 0 })
})
test('mergeProductPatch：patch 不带 stockAlert 时保留原值', () => {
  const list = [product({ id: 1, stock: 10, stockAlert: { out: 1, low: 0 } })]
  const next = mergeProductPatch(list, 1, { stock: 50 })
  assert.equal(next[0].stock, 50)
  assert.deepEqual(next[0].stockAlert, { out: 1, low: 0 })
})
test('mergeProductPatch：不改其它 id 的项', () => {
  const list = [product({ id: 1, stock: 10 }), product({ id: 2, stock: 20 })]
  const next = mergeProductPatch(list, 1, { stock: 99 })
  assert.equal(next[0].stock, 99)
  assert.equal(next[1].stock, 20)
  assert.equal(next[1], list[1], '未命中的项应是同一引用（未被重新构造）')
})

// parseStockInput（复核 R1：库存预警页数字框清空后点「保存」会把 stock 当成 0 提交，
// 规格对顾客变售罄、下一次心跳还会推「已售罄」——空串/空白/负数/小数/非数字都必须判为无效）
test('parseStockInput：空串 → null（无效）', () => {
  assert.equal(parseStockInput(''), null)
})
test('parseStockInput：空白（含全空格）→ null（无效）', () => {
  assert.equal(parseStockInput(' '), null)
  assert.equal(parseStockInput('   '), null)
})
test('parseStockInput："0" → 0（合法，售罄本来就是合法库存值）', () => {
  assert.equal(parseStockInput('0'), 0)
})
test('parseStockInput："-1" → null（负数无效）', () => {
  assert.equal(parseStockInput('-1'), null)
})
test('parseStockInput："1.5" → null（小数无效）', () => {
  assert.equal(parseStockInput('1.5'), null)
})
test('parseStockInput："abc" → null（非数字无效）', () => {
  assert.equal(parseStockInput('abc'), null)
})
test('parseStockInput：" 5 "（首尾空白）→ 5（trim 后合法）', () => {
  assert.equal(parseStockInput(' 5 '), 5)
})
