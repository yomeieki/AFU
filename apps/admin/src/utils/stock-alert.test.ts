import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stockAlertLabel, filterLowStockGroups, countLowStock, unitLabel } from './stock-alert.ts'
import type { LowStockGroup } from '../types'

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
