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
  PLACEHOLDER,
  type SkuRow,
  type SpecDimension,
} from '../src/components/specLogic'

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
  assert.ok(dup.error, '重复应拒绝')
  assert.deepEqual(dims, dimsBefore)
  assert.deepEqual(rows, rowsBefore)

  const empty1 = renameValue(state, 0, '微辣', '')
  assert.ok(empty1.error)
  const empty2 = renameValue(state, 0, '微辣', '   ')
  assert.ok(empty2.error)
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
  assert.ok(dup.error)

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
  assert.ok(r1 && r1.includes('规格值'))

  const dupValues: SpecDimension[] = [{ name: '辣度', values: ['中辣', ' 中辣 '] }]
  const r2 = validateSpecForm(dupValues, [])
  assert.ok(r2 && r2.includes('重复'))

  const blankValues: SpecDimension[] = [{ name: '辣度', values: ['中辣', '   '] }]
  const r3 = validateSpecForm(blankValues, [])
  assert.ok(r3 && r3.length > 0)

  const badPriceRows: SkuRow[] = [row(undefined, ['微辣'], '', 1), row(undefined, ['中辣'], '0', 1)]
  const r4 = validateSpecForm([{ name: '辣度', values: ['微辣', '中辣'] }], badPriceRows)
  assert.ok(r4 && r4.length > 0)

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
  assert.ok(rMissing && rMissing.length > 0)

  // (f) 多一行重复组合（['微辣','带骨'] 出现两次）
  const withDuplicate = [...full, row(undefined, ['微辣', '带骨'], '10', 1)]
  const rDup = validateSpecForm(dims3x2, withDuplicate)
  assert.ok(rDup && rDup.length > 0)

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

  // 注：「特辣」行是新出现的组合，价格从未被填过，天然是空白默认值。
  // 第一轮裁决 plan.md 里 A16 写的是 validateSpecForm 应返回 null，
  // 但按 A13(d)/A11 既有规则「行价格必须 > 0」，这里必然是非空提示——
  // 与 A16 字面断言冲突，已在报告的「上报」栏说明，此处按更基础的
  // 价格必填规则断言（不能反过来放宽 A13(d)）。
  assert.ok(validateSpecForm(removed.state.dimensions, removed.state.rows) !== null)
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
