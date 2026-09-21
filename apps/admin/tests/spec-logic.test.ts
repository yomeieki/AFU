import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createState,
  renameDimension,
  addDimension,
  removeDimension,
  moveDimension,
  moveValue,
  addValue,
  renameValue,
  removeValue,
  validateSpecForm,
  cartesian,
  prepareLoadedState,
  confirmForAddDimension,
  confirmForRemoveDimension,
  confirmForRemoveValue,
  PLACEHOLDER,
  type SkuRow,
  type SpecDimension,
} from '../src/components/specLogic'
import * as msg from '../src/components/specMessages'

function row(id: number | undefined, specValues: string[], price: string, stock: number, originalPrice = ''): SkuRow {
  return id === undefined ? { specValues, price, originalPrice, stock } : { id, specValues, price, originalPrice, stock }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

// ---- A1 规格值改名 ----
test('A1 规格值改名：同步维度与行，保留 id/price/originalPrice/stock，其它行与行顺序不变', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1, '12'),
    row(2, ['微辣', '去骨'], '11', 2, ''),
    row(3, ['中辣', '带骨'], '20', 3, ''),
    row(4, ['中辣', '去骨'], '21', 4, '25'),
  ]
  const before = clone(rows)
  const state = createState(dims, rows)

  const result = renameValue(state, 0, '微辣', '小辣')
  assert.ok(result.state, '不应返回错误')
  const s = result.state!

  assert.deepEqual(s.dimensions[0].values, ['小辣', '中辣'])
  assert.deepEqual(s.dimensions[1].values, ['带骨', '去骨'])

  // 顺序不变
  assert.equal(s.rows.length, 4)
  assert.deepEqual(s.rows.map((r) => r.id), [1, 2, 3, 4])

  // 含该值的两行：specValues[0] 变了，其余字段原样保留
  assert.equal(s.rows[0].specValues[0], '小辣')
  assert.equal(s.rows[0].id, before[0].id)
  assert.equal(s.rows[0].price, before[0].price)
  assert.equal(s.rows[0].originalPrice, before[0].originalPrice)
  assert.equal(s.rows[0].stock, before[0].stock)

  assert.equal(s.rows[1].specValues[0], '小辣')
  assert.equal(s.rows[1].id, before[1].id)
  assert.equal(s.rows[1].price, before[1].price)
  assert.equal(s.rows[1].stock, before[1].stock)

  // 另外两行完全不变
  assert.deepEqual(s.rows[2], before[2])
  assert.deepEqual(s.rows[3], before[3])
})

// ---- A2 改名查重 ----
test('A2 改名查重：重复（去首尾空格后）/空值拒绝且状态不变；改成原名无变化不报错', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '21', 4),
  ]
  const dimsBefore = clone(dims)
  const rowsBefore = clone(rows)
  const state = createState(dims, rows)

  const dup = renameValue(state, 0, '微辣', ' 中辣 ')
  assert.equal(dup.error, msg.msgDuplicateRename('中辣'), '重复应拒绝，文案精确等于 E2')
  assert.deepEqual(dims, dimsBefore)
  assert.deepEqual(rows, rowsBefore)

  const empty1 = renameValue(state, 0, '微辣', '')
  assert.equal(empty1.error, msg.E3_EMPTY_RENAME)
  const empty2 = renameValue(state, 0, '微辣', '   ')
  assert.equal(empty2.error, msg.E3_EMPTY_RENAME)
  assert.deepEqual(dims, dimsBefore)
  assert.deepEqual(rows, rowsBefore)

  const same = renameValue(state, 0, '微辣', '微辣')
  assert.ok(same.state, '改成原名不应报错')
  assert.deepEqual(same.state!.dimensions, dims)
  assert.deepEqual(same.state!.rows, rows)
})

// ---- A3 规格值排序 ----
test('A3 规格值排序：箭头移动后组合表按新笛卡尔积重排，越界移动无变化不抛错', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣', '特辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '21', 4),
    row(5, ['特辣', '带骨'], '30', 5),
    row(6, ['特辣', '去骨'], '31', 6),
  ]
  const state = createState(dims, rows)

  // 把「特辣」（下标 2）移到下标 0：先与中辣换（->1），再与微辣换（->0）
  const step1 = moveValue(state, 0, 2, 'prev').state
  const step2 = moveValue(step1, 0, 1, 'prev').state

  assert.deepEqual(step2.dimensions[0].values, ['特辣', '微辣', '中辣'])
  assert.equal(step2.rows.length, 6)
  assert.deepEqual(step2.rows[0].specValues, ['特辣', '带骨'])
  assert.equal(step2.rows[0].id, 5)
  assert.equal(step2.rows[0].price, '30')
  assert.deepEqual(step2.rows[1].specValues, ['特辣', '去骨'])
  assert.equal(step2.rows[1].id, 6)
  // 每行按内容找到原行，id/price/stock 保留
  const byId = new Map(step2.rows.map((r) => [r.id, r]))
  assert.equal(byId.get(1)!.stock, 1)
  assert.equal(byId.get(3)!.price, '20')

  // 越界移动：下标 0 再上移
  const oob1 = moveValue(step2, 0, 0, 'prev')
  assert.deepEqual(oob1.state, step2)
  // 末位再下移
  const lastIdx = step2.dimensions[0].values.length - 1
  const oob2 = moveValue(step2, 0, lastIdx, 'next')
  assert.deepEqual(oob2.state, step2)
})

// ---- A4 维度排序 ----
test('A4 维度排序：交换维度后每行 specValues 与行顺序同步调换，id/price/stock 保留', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣', '特辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '21', 4),
    row(5, ['特辣', '带骨'], '30', 5),
    row(6, ['特辣', '去骨'], '31', 6),
  ]
  const state = createState(dims, rows)

  const result = moveDimension(state, 1, 'prev') // 骨型移到辣度前
  const s = result.state
  assert.deepEqual(s.dimensions.map((d) => d.name), ['骨型', '辣度'])
  assert.deepEqual(s.rows[0].specValues, ['带骨', '微辣'])
  assert.deepEqual(s.rows[1].specValues, ['带骨', '中辣'])
  assert.equal(s.rows.length, 6)

  const byId = new Map(s.rows.map((r) => [r.id, r]))
  assert.equal(byId.get(1)!.price, '10')
  assert.equal(byId.get(1)!.stock, 1)
  assert.deepEqual(byId.get(5)!.specValues, ['带骨', '特辣'])
})

// ---- A5' / A6' 新增维度保留数据（占位符机制，第一轮复核 R2/R3 修订后） ----
test("A5' 新增维度（占位）：现有行原样保留（含 originalPrice），补第一个值后从占位行复制价格/库存", () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1, '12'),
    row(2, ['微辣', '去骨'], '11', 2, ''),
    row(3, ['中辣', '带骨'], '20', 3, '25'),
    row(4, ['中辣', '去骨'], '21', 4, ''),
  ]
  const before = clone(rows)
  const state = createState(dims, rows)

  const added = addDimension(state, '重量').state
  assert.equal(added.dimensions.length, 3)
  assert.deepEqual(added.dimensions[2].values, [])
  // 新增维度不再清空组合行：4 行原样保留，只是末尾多一个占位符位置
  assert.equal(added.rows.length, 4)
  added.rows.forEach((r, i) => {
    assert.deepEqual(r.specValues, [...before[i].specValues, PLACEHOLDER])
    assert.equal(r.id, before[i].id)
    assert.equal(r.price, before[i].price)
    assert.equal(r.originalPrice, before[i].originalPrice)
    assert.equal(r.stock, before[i].stock)
  })

  const filled = addValue(added, 2, '250g')
  assert.ok(filled.state)
  const s = filled.state!
  assert.equal(s.rows.length, 4)
  for (const r of s.rows) {
    assert.equal(r.specValues.length, 3)
    assert.equal(r.specValues[2], '250g')
    assert.equal('id' in r, false, 'id 不应存在')
  }
  const byPrefix = new Map(s.rows.map((r) => [r.specValues[0] + '/' + r.specValues[1], r]))
  assert.equal(byPrefix.get('微辣/带骨')!.price, '10')
  assert.equal(byPrefix.get('微辣/带骨')!.originalPrice, '12')
  assert.equal(byPrefix.get('微辣/带骨')!.stock, 1)
  assert.equal(byPrefix.get('中辣/去骨')!.price, '21')
  assert.equal(byPrefix.get('中辣/去骨')!.originalPrice, '')
  assert.equal(byPrefix.get('中辣/去骨')!.stock, 4)
})

test("A6' 新增维度后续值：再加一个值同样复制原数据，250g 不变；对另一维度加值后模板已失效，新值为空白默认值", () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '21', 4),
  ]
  const state = createState(dims, rows)
  const added = addDimension(state, '重量').state
  const afterFirst = addValue(added, 2, '250g').state!
  const the250gRowsBefore = clone(afterFirst.rows)

  const afterSecond = addValue(afterFirst, 2, '500g').state!
  assert.equal(afterSecond.rows.length, 8)

  const the500gRows = afterSecond.rows.filter((r) => r.specValues[2] === '500g')
  assert.equal(the500gRows.length, 4)
  for (const r of the500gRows) assert.equal('id' in r, false)
  const byPrefix500 = new Map(the500gRows.map((r) => [r.specValues[0] + '/' + r.specValues[1], r]))
  assert.equal(byPrefix500.get('微辣/带骨')!.price, '10')
  assert.equal(byPrefix500.get('中辣/去骨')!.stock, 4)

  const the250gRowsAfter = afterSecond.rows.filter((r) => r.specValues[2] === '250g')
  assert.deepEqual(
    the250gRowsAfter.sort((a, b) => (a.specValues.join() > b.specValues.join() ? 1 : -1)),
    the250gRowsBefore.sort((a, b) => (a.specValues.join() > b.specValues.join() ? 1 : -1))
  )

  // 再对「辣度」（另一个维度）加值，占位行早已被 250g/500g 填满，不再有可复制的模板
  const afterOtherDim = addValue(afterSecond, 0, '特辣').state!
  const after1kg = addValue(afterOtherDim, 2, '1kg').state!
  const the1kgRows = after1kg.rows.filter((r) => r.specValues[2] === '1kg')
  assert.equal(the1kgRows.length, 6) // 3 个辣度值 × 2 个骨型值
  for (const r of the1kgRows) {
    assert.equal('id' in r, false)
    assert.equal(r.price, '')
    assert.equal(r.originalPrice, '')
    assert.equal(r.stock, 0)
  }
})

// ---- A7 删除维度合并 ----
test('A7 删除维度合并：多行合并取当前行顺序第一行，返回 mergedFrom/mergedTo', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '12', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '22', 4),
  ]
  const state = createState(dims, rows)

  const removeBoneType = removeDimension(state, 1)
  assert.equal(removeBoneType.mergedFrom, 4)
  assert.equal(removeBoneType.mergedTo, 2)
  assert.deepEqual(removeBoneType.state.dimensions.map((d) => d.name), ['辣度'])
  assert.equal(removeBoneType.state.rows.length, 2)
  assert.deepEqual(removeBoneType.state.rows[0].specValues, ['微辣'])
  assert.equal(removeBoneType.state.rows[0].price, '10')
  assert.equal(removeBoneType.state.rows[0].stock, 1)
  assert.equal('id' in removeBoneType.state.rows[0], false)
  assert.deepEqual(removeBoneType.state.rows[1].specValues, ['中辣'])
  assert.equal(removeBoneType.state.rows[1].price, '20')
  assert.equal(removeBoneType.state.rows[1].stock, 3)

  const removeSpicy = removeDimension(state, 0)
  assert.equal(removeSpicy.mergedFrom, 4)
  assert.equal(removeSpicy.mergedTo, 2)
  assert.deepEqual(removeSpicy.state.rows[0].specValues, ['带骨'])
  assert.equal(removeSpicy.state.rows[0].price, '10')
  assert.equal(removeSpicy.state.rows[0].stock, 1)
  assert.deepEqual(removeSpicy.state.rows[1].specValues, ['去骨'])
  assert.equal(removeSpicy.state.rows[1].price, '12')
  assert.equal(removeSpicy.state.rows[1].stock, 2)
})

test("A8' 删除刚新增、还没有值的维度：行与新增前深比较相等（含 id），不触发合并", () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '12', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '22', 4),
  ]
  const state = createState(dims, rows)
  const added = addDimension(state, '重量').state
  const removed = removeDimension(added, 2)

  assert.equal(removed.mergedFrom, removed.mergedTo, '不应触发合并')
  assert.deepEqual(removed.state.dimensions, dims)
  assert.deepEqual(removed.state.rows, rows)
})

test('A9 删除最后一个维度：dimensions 与 rows 都清空', () => {
  const dims: SpecDimension[] = [{ name: '辣度', values: ['微辣', '中辣'] }]
  const rows: SkuRow[] = [row(1, ['微辣'], '10', 1), row(2, ['中辣'], '20', 2)]
  const state = createState(dims, rows)
  const removed = removeDimension(state, 0)
  assert.deepEqual(removed.state.dimensions, [])
  assert.deepEqual(removed.state.rows, [])
})

test('A10 删除规格值：含该值的行被移除，其余行 id 保留，返回受影响的已保存行数', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '12', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '22', 4),
  ]
  const state = createState(dims, rows)
  const result = removeValue(state, 0, '中辣')
  assert.equal(result.affectedSavedRows, 2)
  assert.deepEqual(result.state.dimensions[0].values, ['微辣'])
  assert.equal(result.state.rows.length, 2)
  assert.deepEqual(
    result.state.rows.map((r) => r.id).sort(),
    [1, 2]
  )
})

test('A11 新增规格值：重复拒绝，新值追加到末尾且去首尾空格，新行默认值，原行 id 保留', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨'] },
  ]
  const rows: SkuRow[] = [row(1, ['微辣', '带骨'], '10', 1), row(2, ['中辣', '带骨'], '20', 2)]
  const state = createState(dims, rows)

  const dup = addValue(state, 0, ' 中辣 ')
  assert.equal(dup.error, msg.msgDuplicateNewValue('中辣'), '重复应拒绝，文案精确等于 E1')

  const ok = addValue(state, 0, '  特辣  ')
  assert.ok(ok.state)
  const s = ok.state!
  assert.deepEqual(s.dimensions[0].values, ['微辣', '中辣', '特辣'])
  assert.equal(s.rows.length, 3)
  const newRow = s.rows.find((r) => r.specValues[0] === '特辣')!
  assert.equal(newRow.price, '')
  assert.equal(newRow.originalPrice, '')
  assert.equal(newRow.stock, 0)
  assert.equal('id' in newRow, false)
  assert.equal(s.rows.find((r) => r.specValues[0] === '微辣')!.id, 1)
  assert.equal(s.rows.find((r) => r.specValues[0] === '中辣')!.id, 2)
})

test('A12 按值内容匹配：改名不受拼接文本相同的干扰，id 各自保留', () => {
  const dims1: SpecDimension[] = [
    { name: '规格', values: ['500g/袋', '1kg'] },
    { name: '口味', values: ['原味'] },
  ]
  const rows1: SkuRow[] = [row(7, ['500g/袋', '原味'], '10', 1), row(8, ['1kg', '原味'], '20', 2)]
  const renamed = renameValue(createState(dims1, rows1), 0, '500g/袋', '500g')
  assert.ok(renamed.state)
  assert.equal(renamed.state!.rows.find((r) => r.specValues[0] === '500g')!.id, 7)

  // join('/') 碰撞：['a/b','c'] 与 ['a','b/c'] 拼接后同为 'a/b/c'
  const dims2: SpecDimension[] = [
    { name: 'd1', values: ['a/b', 'a'] },
    { name: 'd2', values: ['c', 'b/c'] },
  ]
  const rows2: SkuRow[] = [
    row(101, ['a/b', 'c'], '1', 1),
    row(102, ['a/b', 'b/c'], '2', 2),
    row(103, ['a', 'c'], '3', 3),
    row(104, ['a', 'b/c'], '4', 4),
  ]
  const state2 = createState(dims2, rows2)
  // 交换 d2 内两个值的顺序，触发按内容重建
  const swapped = moveValue(state2, 1, 0, 'next').state
  const byKey = new Map(swapped.rows.map((r) => [JSON.stringify(r.specValues), r]))
  assert.equal(byKey.get(JSON.stringify(['a/b', 'c']))!.id, 101)
  assert.equal(byKey.get(JSON.stringify(['a', 'b/c']))!.id, 104)
  assert.equal(byKey.get(JSON.stringify(['a/b', 'b/c']))!.id, 102)
  assert.equal(byKey.get(JSON.stringify(['a', 'c']))!.id, 103)
})

test('A13 保存前校验：空值/重复值/空白值/价格缺失都有明确提示，正常数据返回 null', () => {
  const good: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const goodRows: SkuRow[] = [
    row(undefined, ['微辣', '带骨'], '10', 1),
    row(undefined, ['微辣', '去骨'], '11', 2),
    row(undefined, ['中辣', '带骨'], '20', 3),
    row(undefined, ['中辣', '去骨'], '21', 4),
  ]

  const emptyValues: SpecDimension[] = [{ name: '辣度', values: [] }]
  const r1 = validateSpecForm(emptyValues, [])
  assert.equal(r1, msg.msgNoValues('辣度'))

  const dupValues: SpecDimension[] = [{ name: '辣度', values: ['中辣', ' 中辣 '] }]
  const r2 = validateSpecForm(dupValues, [])
  assert.equal(r2, msg.msgDuplicateValueInDim('辣度', '中辣'))

  const blankValues: SpecDimension[] = [{ name: '辣度', values: ['中辣', '   '] }]
  const r3 = validateSpecForm(blankValues, [])
  assert.equal(r3, msg.msgBlankValue('辣度'))

  const badPriceRows: SkuRow[] = [row(undefined, ['微辣'], '', 1), row(undefined, ['中辣'], '0', 1)]
  const r4 = validateSpecForm([{ name: '辣度', values: ['微辣', '中辣'] }], badPriceRows)
  assert.equal(r4, msg.msgRowPriceMissing(['微辣']))

  const r5 = validateSpecForm(good, goodRows)
  assert.equal(r5, null)
})

test('A13(f)(g) 覆盖度校验：行数/组合与 cartesian(dims) 不一致时拒绝，完整覆盖时通过', () => {
  const dims3x2: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣', '特辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const full = cartesian(dims3x2).map((v) => row(undefined, v, '10', 1))

  // (f) 只给 5 行，缺一个组合
  const missingOne = full.slice(0, 5)
  const rMissing = validateSpecForm(dims3x2, missingOne)
  assert.equal(rMissing, msg.V5_MISMATCH)

  // (f) 多一行重复组合（['微辣','带骨'] 出现两次）
  const withDuplicate = [...full, row(undefined, ['微辣', '带骨'], '10', 1)]
  const rDup = validateSpecForm(dims3x2, withDuplicate)
  assert.equal(rDup, msg.V5_MISMATCH)

  // (g) 完整覆盖 6 行 → null
  assert.equal(validateSpecForm(dims3x2, full), null)
})

test('A14 sortOrder 与行顺序：排序后的首行对应 sortOrder 0', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '21', 4),
  ]
  const state = createState(dims, rows)
  const moved = moveDimension(state, 1, 'prev').state
  const payload = moved.rows.map((r, i) => ({ specText: r.specValues.join('/'), sortOrder: i }))
  assert.equal(payload[0].sortOrder, 0)
  assert.equal(payload[0].specText, '带骨/微辣')
})

// ---- A16-A19：第一轮复核 R2/R3 触发条件的回归用例 ----
test('A16（R2-A）：新增空维度期间对已有维度加值，再删掉那个空维度，行按 cartesian 顺序恰为 3 行', () => {
  const dims: SpecDimension[] = [{ name: '辣度', values: ['微辣', '中辣'] }]
  const rows: SkuRow[] = [row(1, ['微辣'], '10', 1), row(2, ['中辣'], '20', 2)]
  const state = createState(dims, rows)

  const added = addDimension(state, '重量').state
  const afterAddValue = addValue(added, 0, '特辣').state!
  const removed = removeDimension(afterAddValue, 1) // 删掉新增的空维度（下标 1）

  assert.deepEqual(removed.state.dimensions.map((d) => d.name), ['辣度'])
  assert.equal(removed.state.rows.length, 3)
  assert.deepEqual(
    removed.state.rows.map((r) => r.specValues),
    [['微辣'], ['中辣'], ['特辣']]
  )
  assert.equal(removed.state.rows[0].id, 1)
  assert.equal(removed.state.rows[0].price, '10')
  assert.equal(removed.state.rows[1].id, 2)
  assert.equal(removed.state.rows[1].price, '20')
  assert.equal('id' in removed.state.rows[2], false)
  assert.equal(removed.state.rows[2].price, '')

  // 「特辣」行是新出现的组合，价格从未被填过，天然是空白默认值。
  // 第二轮裁决确认第一轮 A16 写的「validateSpecForm 返回 null」是笔误：
  // 覆盖度校验（R6）不应误报（行集合与维度已一致），但新行价格未填仍应
  // 被 A13(d) 拦下，所以这里必须严格等于价格提示这一条，而不是覆盖度
  // 提示，也不是笼统的「非 null」。
  assert.equal(
    validateSpecForm(removed.state.dimensions, removed.state.rows),
    msg.msgRowPriceMissing(['特辣'])
  )

  // 补上价格后应恢复为 null（证明卡住的只是价格这一条，不是覆盖度问题）
  const filledRows = removed.state.rows.map((r, i) => (i === 2 ? { ...r, price: '30' } : r))
  assert.equal(validateSpecForm(removed.state.dimensions, filledRows), null)
})

test('A17（R2-B）：新增空维度期间改名已有维度的值，再删掉那个空维度，不残留旧值', () => {
  const dims: SpecDimension[] = [{ name: '辣度', values: ['微辣', '中辣'] }]
  const rows: SkuRow[] = [row(1, ['微辣'], '10', 1), row(2, ['中辣'], '20', 2)]
  const state = createState(dims, rows)

  const added = addDimension(state, '重量').state
  const afterRename = renameValue(added, 0, '微辣', '小辣')
  assert.ok(afterRename.state)
  const removed = removeDimension(afterRename.state!, 1)

  assert.deepEqual(removed.state.rows.map((r) => r.specValues), [['小辣'], ['中辣']])
  assert.equal(removed.state.rows[0].id, 1)
  assert.equal(removed.state.rows[1].id, 2)
  assert.equal(validateSpecForm(removed.state.dimensions, removed.state.rows), null)
  assert.ok(!removed.state.rows.some((r) => r.specValues.includes('微辣')))
})

test('A18（R3）：新增空维度期间删除另一个有值维度必须能识别出已保存行，合并后不带 id', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '12', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '22', 4),
  ]
  const state = createState(dims, rows)
  const added = addDimension(state, '重量').state

  // 此刻仍能看出这些行里有已保存（带 id）的行——不再是空数组
  assert.ok(added.rows.some((r) => r.id !== undefined))

  const removed = removeDimension(added, 0) // 删「辣度」（有值维度），新维度位置仍是占位符
  assert.equal(removed.mergedFrom, 4)
  assert.equal(removed.mergedTo, 2)
  assert.ok(removed.state.rows.every((r) => r.id === undefined))
  assert.ok(validateSpecForm(removed.state.dimensions, removed.state.rows) !== null)
})

test('A19：删除维度最后一个值后回到占位状态，行数不变、id 保留；再补值时从占位行复制、无 id', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [row(1, ['微辣', '带骨'], '10', 1), row(2, ['微辣', '去骨'], '12', 2)]
  const state = createState(dims, rows)

  const afterRemove = removeValue(state, 0, '微辣')
  assert.deepEqual(afterRemove.state.dimensions[0].values, [])
  assert.equal(afterRemove.state.rows.length, 2)
  assert.deepEqual(afterRemove.state.rows[0].specValues, [PLACEHOLDER, '带骨'])
  assert.equal(afterRemove.state.rows[0].id, 1)
  assert.equal(afterRemove.state.rows[0].price, '10')
  assert.deepEqual(afterRemove.state.rows[1].specValues, [PLACEHOLDER, '去骨'])
  assert.equal(afterRemove.state.rows[1].id, 2)

  const afterAddBack = addValue(afterRemove.state, 0, '轻辣')
  assert.ok(afterAddBack.state)
  const s = afterAddBack.state!
  assert.equal(s.rows.length, 2)
  for (const r of s.rows) {
    assert.equal('id' in r, false)
    assert.equal(r.specValues[0], '轻辣')
  }
  assert.equal(s.rows.find((r) => r.specValues[1] === '带骨')!.price, '10')
  assert.equal(s.rows.find((r) => r.specValues[1] === '去骨')!.price, '12')
})

test('addDimension 达到上限（3 个）后不再新增', () => {
  const dims: SpecDimension[] = [
    { name: 'A', values: ['a1'] },
    { name: 'B', values: ['b1'] },
    { name: 'C', values: ['c1'] },
  ]
  const rows: SkuRow[] = [row(1, ['a1', 'b1', 'c1'], '10', 1)]
  const state = createState(dims, rows)
  const result = addDimension(state, 'D')
  assert.equal(result.state.dimensions.length, 3)
  assert.deepEqual(result.state, state)
})

test('moveDimension 越界移动无变化不抛错', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣'] },
    { name: '骨型', values: ['带骨'] },
  ]
  const rows: SkuRow[] = [row(1, ['微辣', '带骨'], '10', 1)]
  const state = createState(dims, rows)
  const first = moveDimension(state, 0, 'prev')
  assert.deepEqual(first.state, state)
  const last = moveDimension(state, 1, 'next')
  assert.deepEqual(last.state, state)
})

test('维度改名不影响组合行', () => {
  const dims: SpecDimension[] = [{ name: '辣度', values: ['微辣'] }]
  const rows: SkuRow[] = [row(1, ['微辣'], '10', 1)]
  const state = createState(dims, rows)
  const renamed = renameDimension(state, 0, '辣度等级')
  assert.equal(renamed.dimensions[0].name, '辣度等级')
  assert.deepEqual(renamed.rows, rows)
})

// ---- A20-A34：第二轮补完（自动整理、无规格加维度默认值、R13 反悔恢复、R7/R8、文案精确） ----

test('A20 打开编辑自动补缺组合：缺一行时自动补齐，价格提示精确到该行，补价格后通过', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1, '12'),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
  ]
  const { state, fixes } = prepareLoadedState(dims, rows)

  assert.equal(state.rows.length, 4)
  assert.deepEqual(
    state.rows.map((r) => r.specValues),
    cartesian(dims)
  )
  assert.deepEqual(state.rows[0], rows[0])
  assert.deepEqual(state.rows[1], rows[1])
  assert.deepEqual(state.rows[2], rows[2])
  assert.deepEqual(state.rows[3], { specValues: ['中辣', '去骨'], price: '', originalPrice: '', stock: 0 })
  assert.equal('id' in state.rows[3], false)
  assert.equal(state.template, null)
  assert.deepEqual(fixes, { addedRows: 1, trimmedValues: 0, droppedRows: 0 })
  assert.equal(msg.loadNoticeText(fixes), '系统发现这个商品少了 1 个规格组合，已经自动补上（价格空着的那几行）。请把价格和库存填好再保存。')
  assert.equal(
    validateSpecForm(state.dimensions, state.rows),
    '组合「中辣 / 去骨」还没有填价格，价格要大于 0'
  )
  const filledRows = state.rows.map((r, i) => (i === 3 ? { ...r, price: '30' } : r))
  assert.equal(validateSpecForm(state.dimensions, filledRows), null)
})

test('A21 打开编辑自动去空格：规格项名与选项去空格，行随之匹配，价格库存不变', () => {
  const dims: SpecDimension[] = [{ name: ' 辣度 ', values: [' 微辣', '中辣 '] }]
  const rows: SkuRow[] = [row(1, [' 微辣'], '10', 1), row(2, ['中辣 '], '20', 2)]
  const { state, fixes } = prepareLoadedState(dims, rows)

  assert.deepEqual(state.dimensions, [{ name: '辣度', values: ['微辣', '中辣'] }])
  assert.deepEqual(state.rows[0], { id: 1, specValues: ['微辣'], price: '10', originalPrice: '', stock: 1 })
  assert.deepEqual(state.rows[1], { id: 2, specValues: ['中辣'], price: '20', originalPrice: '', stock: 2 })
  assert.deepEqual(fixes, { addedRows: 0, trimmedValues: 3, droppedRows: 0 })
  assert.equal(msg.loadNoticeText(fixes), '系统已自动去掉了规格名称里多余的空格，保存后会一起更新。')
})

test('A22 打开编辑完整数据零改动：顺序一致时原样返回；顺序不一致时按 cartesian 重排、id 保留、fixes 全 0', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const orderedRows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '21', 4),
  ]
  const same = prepareLoadedState(dims, orderedRows)
  assert.deepEqual(same.state.rows, orderedRows)
  assert.deepEqual(same.fixes, { addedRows: 0, trimmedValues: 0, droppedRows: 0 })
  assert.equal(msg.loadNoticeText(same.fixes), null)

  const shuffled: SkuRow[] = [orderedRows[2], orderedRows[0], orderedRows[3], orderedRows[1]]
  const reordered = prepareLoadedState(dims, shuffled)
  assert.deepEqual(reordered.state.rows, orderedRows)
  assert.deepEqual(reordered.fixes, { addedRows: 0, trimmedValues: 0, droppedRows: 0 })
})

test('A23 打开编辑去重清理：去空格后重复的选项与行都清理，droppedRows 计数正确', () => {
  const dims: SpecDimension[] = [{ name: '辣度', values: ['中辣', '中辣 '] }]
  const rows: SkuRow[] = [row(1, ['中辣'], '10', 1), row(2, ['中辣 '], '20', 2)]
  const { state, fixes } = prepareLoadedState(dims, rows)

  assert.deepEqual(state.dimensions, [{ name: '辣度', values: ['中辣'] }])
  assert.equal(state.rows.length, 1)
  assert.equal(state.rows[0].id, 1)
  assert.deepEqual(fixes, { addedRows: 0, trimmedValues: 1, droppedRows: 1 })
  assert.equal(
    msg.loadNoticeText(fixes),
    '系统已自动去掉了规格名称里多余的空格，保存后会一起更新。\n有 1 个对不上的规格组合已自动清理，保存后会一起更新。'
  )
})

test('A24 无规格商品新加规格项带默认值：defaults 只在从 0 个规格项开始时生效，库存默认按调用方传入值', () => {
  const state0 = createState([], [])
  const added = addDimension(state0, '辣度', { price: '29.9', originalPrice: '39.9', stock: 10 }).state
  assert.equal(added.rows.length, 1)
  assert.deepEqual(added.rows[0], { specValues: [''], price: '29.9', originalPrice: '39.9', stock: 10 })
  assert.equal('id' in added.rows[0], false)

  const withFirstValue = addValue(added, 0, '微辣')
  assert.ok(withFirstValue.state)
  assert.equal(withFirstValue.state!.rows.length, 1)
  assert.deepEqual(withFirstValue.state!.rows[0], { specValues: ['微辣'], price: '29.9', originalPrice: '39.9', stock: 10 })

  const withSecondValue = addValue(withFirstValue.state!, 0, '中辣')
  assert.ok(withSecondValue.state)
  assert.equal(withSecondValue.state!.rows.length, 2)
  for (const r of withSecondValue.state!.rows) {
    assert.equal(r.price, '29.9')
    assert.equal(r.originalPrice, '39.9')
    assert.equal(r.stock, 10)
    assert.equal('id' in r, false)
  }
  assert.equal(validateSpecForm(withSecondValue.state!.dimensions, withSecondValue.state!.rows), null)

  // 不传 defaults → 占位行为空白默认值
  const addedNoDefaults = addDimension(state0, '辣度').state
  assert.deepEqual(addedNoDefaults.rows[0], { specValues: [''], price: '', originalPrice: '', stock: 0 })

  // 对已有规格项的状态传 defaults → 不生效，结果与不传时深比较相等
  const dims2: SpecDimension[] = [{ name: '辣度', values: ['微辣'] }]
  const rows2: SkuRow[] = [row(1, ['微辣'], '10', 1)]
  const state2 = createState(dims2, rows2)
  const withDefaultsIgnored = addDimension(state2, '重量', { price: '29.9', originalPrice: '39.9', stock: 10 }).state
  const withoutDefaults = addDimension(state2, '重量').state
  assert.deepEqual(withDefaultsIgnored, withoutDefaults)
})

test('A25 R13 反悔恢复：加规格项→加值→（手改价格）→删规格项，回到原样，手改的价格不保留', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1, '12'),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3, '25'),
    row(4, ['中辣', '去骨'], '21', 4),
  ]
  const state0 = createState(dims, rows)
  const added = addDimension(state0).state
  const afterFirst = addValue(added, 2, '250g').state!
  const afterSecond = addValue(afterFirst, 2, '500g').state!
  const modified = { ...afterSecond, rows: afterSecond.rows.map((r, i) => (i === 0 ? { ...r, price: '99' } : r)) }

  const removed = removeDimension(modified, 2)
  assert.equal(removed.restored, true)
  assert.equal(removed.mergedFrom, 8)
  assert.equal(removed.mergedTo, 4)
  assert.deepEqual(removed.state.dimensions, dims)
  assert.deepEqual(removed.state.rows, rows)
  assert.equal(removed.state.template, null)
})

test('A26 R13 变体：把新规格项的值全删掉再删规格项，同样能恢复', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1, '12'),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3, '25'),
    row(4, ['中辣', '去骨'], '21', 4),
  ]
  const state0 = createState(dims, rows)
  const added = addDimension(state0).state
  const afterAddValues = addValue(addValue(added, 2, '250g').state!, 2, '500g').state!

  const rv1 = removeValue(afterAddValues, 2, '500g')
  assert.equal(rv1.affectedSavedRows, 0)
  const rv2 = removeValue(rv1.state, 2, '250g')
  assert.equal(rv2.affectedSavedRows, 0)
  assert.deepEqual(rv2.state.rows, added.rows)
  assert.equal(rv2.state.template?.dimIndex, 2)
  assert.equal(confirmForRemoveDimension(rv2.state, 2), null)

  const removed = removeDimension(rv2.state, 2)
  assert.deepEqual(removed.state.rows, rows)
})

test('A27 R13 边界：中途改动了另一个规格项，template 失效，删规格项不再恢复而是走普通合并', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '21', 4),
  ]
  const state0 = createState(dims, rows)
  const added = addDimension(state0).state
  const afterAddValue = addValue(added, 2, '250g').state!
  const afterOtherDim = addValue(afterAddValue, 0, '特辣').state!

  assert.equal(afterOtherDim.template, null, '碰了另一个规格项，template 应已失效')
  assert.equal(afterOtherDim.rows.length, 6)

  // 注：方案文本给出的 removeDimension(2) 在此状态下（被删规格项只有 1 个选项 250g）
  // 数学上不可能产生合并（去掉一个「所有行取值都相同」的维度不会让任何两行的
  // 其余取值发生碰撞），mergedFrom/mergedTo 必然相等；实测也是 6/6，restored 为
  // false。删规格项 1（骨型，2 个选项，会与 250g 一起碰撞合并）才会重现
  // mergedFrom=6、mergedTo=3 这组数字，这里按实测行为分别断言两者，并在交付
  // 报告的「偏离方案」里说明与方案原文数字（mergedTo=3 对应 removeDimension(2)）
  // 的不一致（上报条件：验收标准自相矛盾）。
  const removedNewDim = removeDimension(afterOtherDim, 2)
  assert.equal(removedNewDim.restored, false)
  assert.ok(removedNewDim.state.rows.every((r) => r.id === undefined))
  assert.equal(removedNewDim.mergedFrom, 6)
  assert.equal(removedNewDim.mergedTo, 6)

  const removedOtherDim = removeDimension(afterOtherDim, 1)
  assert.equal(removedOtherDim.restored, false)
  assert.ok(removedOtherDim.state.rows.every((r) => r.id === undefined))
  assert.equal(removedOtherDim.mergedFrom, 6)
  assert.equal(removedOtherDim.mergedTo, 3)
})

test('A28 confirmForAddDimension：带 id 行返回 C1；无 id（新商品）或无规格项时不弹', () => {
  const dims: SpecDimension[] = [{ name: '辣度', values: ['微辣'] }]
  const withId = createState(dims, [row(1, ['微辣'], '10', 1)])
  const c1 = confirmForAddDimension(withId)
  assert.deepEqual(c1, {
    title: '添加规格项',
    content:
      '加了新的规格项以后，原来的每个规格会按新规格项拆成好几个，价格和库存会先照原来的填好，保存前请核对一遍。\n' +
      '保存以后，顾客购物车里原来选的这个商品会被清空。要继续吗？',
    danger: false,
    confirmText: '继续添加',
    cancelText: '先不加',
  })

  const withoutId = createState(dims, [row(undefined, ['微辣'], '10', 1)])
  assert.equal(confirmForAddDimension(withoutId), null)

  assert.equal(confirmForAddDimension(createState([], [])), null)
})

test('A29 confirmForRemoveDimension：按 (1)(2)(3)(4) 顺序覆盖各分支', () => {
  const dims2: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows4: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '21', 4),
  ]
  // (a) 2 维 4 行带 id 删骨型 → C3
  const stateA = createState(dims2, rows4)
  const confirmA = confirmForRemoveDimension(stateA, 1)
  assert.deepEqual(confirmA, {
    title: '删掉规格项',
    content:
      '删掉「骨型」后，现在的 4 个组合会合并成 2 个，合并后的价格和库存取原来第一行的，保存前请核对一遍。\n' +
      '保存以后，原来的规格会被删掉重建，顾客购物车里选了这个商品的记录会被清空。确定删掉吗？',
    danger: true,
    confirmText: '删掉',
    cancelText: '不删了',
  })
  assert.ok(confirmA!.content.includes('现在的 4 个组合会合并成 2 个'))

  // (b) 1 维 2 行带 id 删它 → C2
  const dims1: SpecDimension[] = [{ name: '辣度', values: ['微辣', '中辣'] }]
  const stateB = createState(dims1, [row(1, ['微辣'], '10', 1), row(2, ['中辣'], '20', 2)])
  assert.deepEqual(confirmForRemoveDimension(stateB, 0), {
    title: '删掉规格项',
    content:
      '删掉最后一个规格项后，这个商品就不分规格了，售价和库存要在下面的「售价 / 库存」里填。\n' +
      '保存以后，原来的规格都会被删掉，顾客购物车里选了这个商品的记录会被清空。确定删掉吗？',
    danger: true,
    confirmText: '删掉',
    cancelText: '不删了',
  })

  // (c) A25 的删规格项前状态 → C4
  const added = addDimension(stateA).state
  const afterAddValues = addValue(addValue(added, 2, '250g').state!, 2, '500g').state!
  assert.deepEqual(confirmForRemoveDimension(afterAddValues, 2), {
    title: '删掉规格项',
    content: '删掉「第 3 个规格项」后，规格会恢复成加它之前的样子，原来的价格和库存都还在。确定删掉吗？',
    danger: false,
    confirmText: '删掉',
    cancelText: '不删了',
  })

  // (d) 无值规格项 → null
  assert.equal(confirmForRemoveDimension(added, 2), null)

  // (e) 有值但全部无 id、非恢复路径 → null
  const afterOtherDim = addValue(afterAddValues, 0, '特辣').state!
  assert.equal(confirmForRemoveDimension(afterOtherDim, 2), null)

  // (f) 规格项名为空时 content 用「第 2 个规格项」
  const dimsUnnamed: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '', values: ['带骨', '去骨'] },
  ]
  const stateUnnamed = createState(dimsUnnamed, rows4)
  const confirmUnnamed = confirmForRemoveDimension(stateUnnamed, 1)
  assert.ok(confirmUnnamed!.content.includes('第 2 个规格项'))
})

test('A30 confirmForRemoveValue：受影响带 id 行数 > 0 才弹 C6', () => {
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [
    row(1, ['微辣', '带骨'], '10', 1),
    row(2, ['微辣', '去骨'], '11', 2),
    row(3, ['中辣', '带骨'], '20', 3),
    row(4, ['中辣', '去骨'], '21', 4),
  ]
  const state = createState(dims, rows)
  assert.deepEqual(confirmForRemoveValue(state, 0, '中辣'), {
    title: '删掉选项',
    content: '删掉「中辣」后，保存时会一起删掉 2 个已有的规格，顾客购物车里选了这些规格的记录会被清空。确定删掉吗？',
    danger: true,
    confirmText: '删掉',
    cancelText: '不删了',
  })

  const withoutId = createState(dims, rows.map((r) => ({ ...r, id: undefined })))
  assert.equal(confirmForRemoveValue(withoutId, 0, '中辣'), null)
})

test('A31 R8 已有值也 trim 比较：查重、改名与自身去空格版本相同都按预期处理', () => {
  const dims: SpecDimension[] = [{ name: '辣度', values: ['中辣 ', '微辣'] }]
  const rows: SkuRow[] = [row(1, ['中辣 '], '10', 1), row(2, ['微辣'], '20', 2)]
  const state = createState(dims, rows)

  const dup = addValue(state, 0, '中辣')
  assert.equal(dup.error, '「中辣」已经有了，不用再加')

  const dupRename = renameValue(state, 0, '微辣', '中辣')
  assert.equal(dupRename.error, '已经有一个叫「中辣」的选项了，请换个名字')

  const selfTrim = renameValue(state, 0, '中辣 ', '中辣')
  assert.ok(selfTrim.state)
  assert.deepEqual(selfTrim.state!.dimensions[0].values, ['中辣', '微辣'])
  const renamedRow = selfTrim.state!.rows.find((r) => r.id === 1)!
  assert.deepEqual(renamedRow.specValues, ['中辣'])

  const noop = renameValue(state, 0, '微辣', '微辣')
  assert.ok(noop.state)
  assert.deepEqual(noop.state, state)
})

test('A32 E 组文案精确：空值提示与已有测试用例的精确文案', () => {
  const dims: SpecDimension[] = [{ name: '辣度', values: ['微辣'] }]
  const state = createState(dims, [row(1, ['微辣'], '10', 1)])

  const emptyAdd = addValue(state, 0, '  ')
  assert.equal(emptyAdd.error, '请先输入选项名')

  const emptyRename = renameValue(state, 0, '微辣', '  ')
  assert.equal(emptyRename.error, '选项名不能是空的，已恢复原来的名字')
})

test('A33 V 组文案精确：V1-V6 逐条验证', () => {
  // V1：无名规格项
  assert.equal(validateSpecForm([{ name: '', values: [] }], []), '规格项「第 1 个规格项」还没有选项，请至少加一个')
  // V2
  assert.equal(
    validateSpecForm([{ name: '辣度', values: ['中辣', '  '] }], []),
    '规格项「辣度」里有空白的选项，请删掉或填上名字'
  )
  // V3
  assert.equal(
    validateSpecForm([{ name: '辣度', values: ['中辣', '中辣 '] }], []),
    '规格项「辣度」里「中辣」出现了两次，请删掉一个'
  )
  // V4：占位符行（理论兜底，正常 UI 流程不会出现规格项有值但行仍占位）
  const dimsWithPlaceholderRow: SpecDimension[] = [{ name: '辣度', values: ['微辣'] }]
  assert.equal(
    validateSpecForm(dimsWithPlaceholderRow, [row(undefined, [PLACEHOLDER], '10', 1)]),
    '有规格项还没有选项，请先添加选项再保存'
  )
  // V5：行数与笛卡尔积不一致（理论兜底）
  const dims2: SpecDimension[] = [{ name: '辣度', values: ['微辣', '中辣'] }]
  assert.equal(
    validateSpecForm(dims2, [row(undefined, ['微辣'], '10', 1)]),
    '规格组合和选项对不上，请关掉编辑窗口重新打开后再试'
  )
  // V6
  assert.equal(
    validateSpecForm([{ name: '辣度', values: ['特辣'] }], [row(undefined, ['特辣'], '', 0)]),
    '组合「特辣」还没有填价格，价格要大于 0'
  )
})

test('A34 removeValue 删最后一个值：template 命中该规格项时恢复 template.rows，否则维持 A19 的占位行为', () => {
  // 命中：从「无规格商品加第一个规格项」这条路径产生 template
  const state0 = createState([], [])
  const added = addDimension(state0).state
  const withValue = addValue(added, 0, '微辣').state!
  const removedWithTemplate = removeValue(withValue, 0, '微辣')
  assert.deepEqual(removedWithTemplate.state.rows, added.rows)
  assert.deepEqual(removedWithTemplate.state.template, withValue.template)

  // 未命中（A19 原有行为）：没有 template 时占位、id 保留、template 为 null
  const dims: SpecDimension[] = [
    { name: '辣度', values: ['微辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const rows: SkuRow[] = [row(1, ['微辣', '带骨'], '10', 1), row(2, ['微辣', '去骨'], '12', 2)]
  const state = createState(dims, rows)
  const afterRemove = removeValue(state, 0, '微辣')
  assert.deepEqual(afterRemove.state.rows[0].specValues, [PLACEHOLDER, '带骨'])
  assert.equal(afterRemove.state.rows[0].id, 1)
  assert.equal(afterRemove.state.template, null)
})
