// 分类页分组与高亮判定的行为锁。
//
// 「菜归哪段」「哪段该亮」是两条顾客直接能感知的规则：分错段顾客会以为菜不见了，
// 高亮判错顾客会以为自己点错了分类。抽成纯函数单测锁死边界，页面（list.js）只管
// 拉数据、量位置、setData，不重复判断这些规则。
const test = require('node:test')
const assert = require('node:assert/strict')

const { groupByCategory, activeGroupOf, OTHER_ID } = require('../../apps/miniapp/utils/catalog-groups')

test('分组顺序按 categories 给定顺序，不按商品出现顺序', function () {
  const categories = [{ id: 2, name: '凉菜' }, { id: 1, name: '特色菜' }]
  const products = [{ id: 10, categoryId: 1 }, { id: 11, categoryId: 2 }]
  const groups = groupByCategory(categories, products)
  assert.deepEqual(groups.map((g) => g.id), [2, 1])
})

test('空分类保留，items 为空数组（邮寄 3 个空分类场景）', function () {
  const categories = [
    { id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }, { id: 4, name: 'D' },
    { id: 5, name: '礼盒' }, { id: 6, name: '预包装食品' }, { id: 7, name: '素食' },
  ]
  const products = [
    { id: 100, categoryId: 1 }, { id: 101, categoryId: 2 }, { id: 102, categoryId: 3 }, { id: 103, categoryId: 4 },
  ]
  const groups = groupByCategory(categories, products)
  assert.equal(groups.length, 7)
  assert.deepEqual(groups[4].items, [])
  assert.equal(groups[4].name, '礼盒')
  assert.deepEqual(groups[5].items, [])
  assert.equal(groups[5].name, '预包装食品')
  assert.deepEqual(groups[6].items, [])
  assert.equal(groups[6].name, '素食')
})

test('未知 categoryId 归到末尾「其他」段；都能对上时不出现「其他」', function () {
  const categories = [{ id: 1, name: '特色菜' }]
  const withUnknown = groupByCategory(categories, [{ id: 1, categoryId: 1 }, { id: 2, categoryId: 99 }])
  assert.equal(withUnknown[withUnknown.length - 1].id, OTHER_ID)
  assert.equal(withUnknown[withUnknown.length - 1].name, '其他')
  assert.deepEqual(withUnknown[withUnknown.length - 1].items, [{ id: 2, categoryId: 99 }])

  const allMatched = groupByCategory(categories, [{ id: 1, categoryId: 1 }])
  assert.equal(allMatched.some((g) => g.id === 'other'), false)
})

test('段内顺序保持输入顺序（服务端排好，小程序不排）', function () {
  const categories = [{ id: 1, name: '特色菜' }]
  const products = [
    { id: 3, categoryId: 1 }, { id: 1, categoryId: 1 }, { id: 2, categoryId: 1 },
  ]
  const groups = groupByCategory(categories, products)
  assert.deepEqual(groups[0].items.map((p) => p.id), [3, 1, 2])
})

test('分类为空/null 但商品非空 → 只有一个「其他」段；products 为 null → 每段 items 为 []；两者都空 → []', function () {
  const onlyOther = groupByCategory([], [{ id: 1, categoryId: 1 }])
  assert.deepEqual(onlyOther.map((g) => g.id), [OTHER_ID])

  const onlyOtherNullCats = groupByCategory(null, [{ id: 1, categoryId: 1 }])
  assert.deepEqual(onlyOtherNullCats.map((g) => g.id), [OTHER_ID])

  const emptyItems = groupByCategory([{ id: 1, name: '特色菜' }], null)
  assert.deepEqual(emptyItems, [{ id: 1, name: '特色菜', items: [] }])

  const bothEmpty = groupByCategory([], null)
  assert.deepEqual(bothEmpty, [])
})

test('activeGroupOf 边界：段顶、段间、容差、滚到底、回弹、无 offsets', function () {
  const offsets = [{ id: 1, top: 0 }, { id: 2, top: 400 }, { id: 3, top: 900 }]
  assert.equal(activeGroupOf(offsets, 0), 1)
  assert.equal(activeGroupOf(offsets, 400), 2, '正好在段顶')
  assert.equal(activeGroupOf(offsets, 399), 1, '段间')
  assert.equal(activeGroupOf(offsets, 398, 2), 2, '容差内')
  assert.equal(activeGroupOf(offsets, 5000), 3, '滚到底')
  assert.equal(activeGroupOf(offsets, -10), 1, 'iOS 回弹的负值')
  assert.equal(activeGroupOf([], 100), null)
  assert.equal(activeGroupOf(offsets, 399), 1, 'tolerance 缺省按 0')
})
